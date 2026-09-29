// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // GTK's thin overlay indicators paint above HTML tooltips, including
    // top-layer popovers. Use regular scrollbars in every Linux WebView.
    // Set this before GTK/WebKit initialization or any worker threads start.
    #[cfg(target_os = "linux")]
    std::env::set_var("GTK_OVERLAY_SCROLLING", "0");

    if let Some(status) =
        agentero_lib::features::paper::import::pdf_parse::try_run_pdf_parse_worker()
    {
        std::process::exit(status);
    }
    agentero_lib::run()
}
