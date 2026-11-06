import { useState, type ReactNode } from "react";
import { useT } from "../i18n";

export function HubLink({ href, children }: { href: string; children: ReactNode }) {
	const t = useT();
	const [failed, setFailed] = useState(false);
	const [opening, setOpening] = useState(false);
	return (
		<>
			<a
				className="dc-button"
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				onClick={(event) => {
					const desktop = (window as unknown as { piDesktop?: { openHub?: (url: string) => Promise<boolean> } })
						.piDesktop;
					if (!desktop?.openHub) return;
					event.preventDefault();
					if (opening) return;
					setOpening(true);
					setFailed(false);
					void desktop
						.openHub(href)
						.then(
							(ok) => setFailed(!ok),
							() => setFailed(true),
						)
						.finally(() => setOpening(false));
				}}
				aria-busy={opening}
			>
				{children}
			</a>
			{failed && (
				<span role="alert">
					{t("deviceHubNetworkError")}{" "}
					<a href={href} target="_blank" rel="noopener noreferrer">
						{href}
					</a>
				</span>
			)}
		</>
	);
}
