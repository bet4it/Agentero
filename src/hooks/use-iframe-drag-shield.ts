import { useEffect, useState } from "react";

/** Disable iframe hit-testing during HTML5 DnD so Dockview receives dragover. */
export function useIframeDragShield(): boolean {
	const [dragShield, setDragShield] = useState(false);

	useEffect(() => {
		const arm = () => setDragShield(true);
		const disarm = () => setDragShield(false);
		window.addEventListener("dragstart", arm, true);
		window.addEventListener("dragend", disarm, true);
		window.addEventListener("drop", disarm, true);
		return () => {
			window.removeEventListener("dragstart", arm, true);
			window.removeEventListener("dragend", disarm, true);
			window.removeEventListener("drop", disarm, true);
		};
	}, []);

	return dragShield;
}
