import chalk from "chalk";

export interface UIState {
	qrCode: string;
	/** Canonical onboarding token */
	pin?: string;
	/** Back-compat alias */
	pairingCode?: string;
	localURL: string;
	status: "starting" | "ready" | "connected" | "error";
	errorMessage?: string;
}

/**
 * Format PIN with a space for readability: "847291" -> "847 291"
 */
export function formatPIN(pin: string): string {
	if (pin.length !== 6) return pin;
	return `${pin.slice(0, 3)} ${pin.slice(3)}`;
}

export const formatPairingCode = formatPIN;

/**
 * Render the full terminal UI with QR code, PIN, and status
 * @param state - Current UI state including QR code, PIN, URL, and status
 */
export async function renderUI(state: UIState): Promise<void> {
	console.clear();

	const { qrCode, localURL, status, errorMessage } = state;
	const pin = state.pin ?? state.pairingCode ?? "";

	// Box drawing
	console.log(chalk.cyan("┌─────────────────────────────────────────────────────────────┐"));
	console.log(
		`${chalk.cyan("│")}${chalk.bold.white("                      Guild Remote                           ")}${chalk.cyan("│")}`,
	);
	console.log(chalk.cyan("│                                                             │"));

	// QR code lines (split and display)
	const qrLines = qrCode.split("\n");
	for (const line of qrLines) {
		console.log(`${chalk.cyan("│")}   ${line.padEnd(57)}${chalk.cyan("│")}`);
	}

	// Instructions and pairing code
	console.log(`${chalk.cyan("│")}${"".padEnd(61)}${chalk.cyan("│")}`);
	console.log(
		`${chalk.cyan("│")}${"   Scan with iPhone Camera or enter PIN:".padEnd(61)}${chalk.cyan("│")}`,
	);
	console.log(
		`${chalk.cyan("│")}${chalk.bold.yellow(`                    ${formatPairingCode(pin)}                          `)}${chalk.cyan("│")}`,
	);
	console.log(`${chalk.cyan("│")}${"".padEnd(61)}${chalk.cyan("│")}`);
	console.log(
		`${chalk.cyan("│")}${chalk.dim(`   Local: ${localURL}`.padEnd(61))}${chalk.cyan("│")}`,
	);

	// Status line
	let statusText: string;
	if (status === "error" && errorMessage) {
		statusText = chalk.red(`   ✗ Error: ${errorMessage}`);
	} else if (status === "ready") {
		statusText = chalk.green("   Advertising via Bonjour... Ready for connections");
	} else if (status === "connected") {
		statusText = chalk.green("   ✓ Device connected");
	} else {
		statusText = chalk.yellow("   Starting...");
	}

	console.log(`${chalk.cyan("│")}${statusText.padEnd(68)}${chalk.cyan("│")}`);

	console.log(chalk.cyan("└─────────────────────────────────────────────────────────────┘"));
}

/**
 * Update just the status line without full redraw
 * Moves cursor to the status line and updates it
 * @param status - Status message to display
 */
export function updateStatus(status: string): void {
	// Move cursor up to status line (2 lines from bottom)
	process.stdout.write("\x1b[2A");
	// Clear the line
	process.stdout.write("\x1b[K");
	// Write new status
	console.log(`${chalk.cyan("│")}${status.padEnd(68)}${chalk.cyan("│")}`);
	// Move cursor back down to maintain position
	process.stdout.write("\x1b[1B");
}
