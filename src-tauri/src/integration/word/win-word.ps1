# Agentero Word driver. Talks to the running Word.Application over COM.
# The JSON path is data, never code. Requires Windows PowerShell 5.1 -STA.
$ErrorActionPreference = "Stop"
try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8
    [Console]::InputEncoding = $utf8
    $OutputEncoding = $utf8
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = 67108864
    $inputPath = $args[0]
    if (-not $inputPath) { throw "word.invalidPath" }
    $raw = [System.IO.File]::ReadAllText($inputPath, [System.Text.UTF8Encoding]::new($false))
    $request = $serializer.DeserializeObject($raw)
    $word = [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
    if ($word.Documents.Count -lt 1) { throw "word.noDocument" }
    $doc = $word.ActiveDocument

    function Same-Text([string]$actual, [string]$expected) {
        # COM Result.Text keeps a trailing CR that AppleScript content() omits.
        return $actual.TrimEnd("`r", "`n") -eq $expected.TrimEnd("`r", "`n")
    }

    function Find-FieldAt([int64]$start) {
        for ($i = 1; $i -le $doc.Fields.Count; $i++) {
            $candidate = $doc.Fields.Item($i)
            if ([int64]$candidate.Code.Start -eq $start) { return $candidate }
        }
        return $null
    }

    function Read-Snapshot {
        if ($doc.ReadOnly) { throw "word.readOnly" }
        if ($doc.TrackRevisions) { throw "word.trackChanges" }
        if ($doc.Footnotes.Count -gt 0 -or $doc.Endnotes.Count -gt 0) { throw "word.notesUnsupported" }
        $fields = New-Object System.Collections.ArrayList
        for ($i = 1; $i -le $doc.Fields.Count; $i++) {
            $field = $doc.Fields.Item($i)
            [void]$fields.Add(@{
                index = $i - 1
                code = [string]$field.Code.Text
                text = [string]$field.Result.Text
                start = [int64]$field.Code.Start
                end = [int64]$field.Result.End
            })
        }
        $selection = $word.Selection
        $story = if ([int]$selection.StoryType -eq 1) { "wdMainTextStory" } else { "wdOtherStory" }
        return @{
            name = [string]$doc.Name
            path = [string]$doc.FullName
            content = [string]$doc.Content.Text
            fields = $fields
            start = [int64]$selection.Start
            end = [int64]$selection.End
            story = $story
        }
    }

    $current = Read-Snapshot
    if ($request["action"] -eq "read") {
        [Console]::Out.Write($serializer.Serialize($current))
        exit 0
    }
    $expected = $request["snapshot"]
    if ($current.name -ne $expected["name"] -or $current.path -ne $expected["path"] -or $current.content -ne $expected["content"]) {
        throw "word.documentChanged"
    }
    if ($current.fields.Count -ne @($expected["fields"]).Count) { throw "word.documentChanged" }
    for ($i = 0; $i -lt $current.fields.Count; $i++) {
        $actual = $current.fields[$i]
        $prior = $expected["fields"][$i]
        if ($actual.code -ne $prior["code"] -or $actual.text -ne $prior["text"] -or [int64]$actual.start -ne [int64]$prior["start"] -or [int64]$actual.end -ne [int64]$prior["end"]) {
            throw "word.documentChanged"
        }
    }
    if ($current.start -ne [int64]$expected["start"] -or $current.end -ne [int64]$expected["end"]) {
        throw "word.selectionChanged"
    }

    $changes = @()
    if ($null -ne $request["changes"]) { $changes = @($request["changes"]) }
    foreach ($change in $changes) {
        $index = [int]$change["index"]
        if ($index -lt 0 -or $index -ge $doc.Fields.Count) { throw "word.documentChanged" }
    }
    $ordered = $changes | Sort-Object { [int]$_["index"] } -Descending
    foreach ($change in $ordered) {
        $field = $doc.Fields.Item([int]$change["index"] + 1)
        $field.Code.Text = [string]$change["code"]
        $field.Result.Text = [string]$change["text"]
        $field.ShowCodes = $false
        if (-not (Same-Text ([string]$field.Result.Text) ([string]$change["text"]))) { throw "word.insertFailed" }
    }

    $insert = $request["insert"]
    if ($null -ne $insert) {
        $position = [int64]$expected["start"]
        foreach ($change in $changes) {
            $prior = $expected["fields"][[int]$change["index"]]
            if ([int64]$prior["end"] -lt [int64]$expected["start"]) {
                $position += ([string]$change["code"]).Length - ([string]$prior["code"]).Length
                $position += ([string]$change["text"]).Length - ([string]$prior["text"]).Length
            }
        }
        $range = $doc.Range([int]$position, [int]$position)
        # An ADDIN field has no result separator, so the citation text would land
        # outside it. Start from a print-date field, which already has a result,
        # then replace its instruction. Same sequence as the macOS driver.
        $null = $doc.Fields.Add($range, 23, [Type]::Missing, $false)
        $field = Find-FieldAt ($position + 1)
        if ($null -eq $field) { throw "word.insertFailed" }
        $field.Code.Text = [string]$insert["code"]
        $field.Result.Text = [string]$insert["text"]
        if (-not (Same-Text ([string]$field.Result.Text) ([string]$insert["text"]))) { throw "word.insertFailed" }
        $field.ShowCodes = $false
        $end = [int64]$field.Result.End + 1
        $word.Selection.Start = $end
        $word.Selection.End = $end
    }
    $word.Activate() | Out-Null
    [Console]::Out.Write($serializer.Serialize(@{ ok = $true }))
    exit 0
} catch {
    $message = "$_"
    if ($message -match "word\.[A-Za-z]+") {
        [Console]::Error.WriteLine($Matches[0])
    } elseif ($message -match "Operation unavailable") {
        [Console]::Error.WriteLine("word.noDocument")
    } else {
        [Console]::Error.WriteLine($message)
    }
    exit 1
}
