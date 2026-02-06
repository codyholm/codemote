import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface DetectTailscaleEndpointOptions {
	port: number;
	secure: boolean;
}

interface TailscaleStatusSelf {
	DNSName?: string;
	HostName?: string;
	TailscaleIPs?: string[];
}

interface TailscaleStatus {
	Self?: TailscaleStatusSelf;
}

export interface TailscaleEndpoint {
	url: string;
	host: string;
}

export async function detectTailscaleEndpoint(
	options: DetectTailscaleEndpointOptions,
): Promise<TailscaleEndpoint | null> {
	const host = (await hostFromStatusJson()) ?? (await hostFromIpFallback());
	if (!host) {
		return null;
	}

	const scheme = options.secure ? "wss" : "ws";
	const hostForURL = host.includes(":") ? `[${host}]` : host;
	return {
		host,
		url: `${scheme}://${hostForURL}:${options.port}/ws`,
	};
}

async function hostFromStatusJson(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
			timeout: 1500,
			maxBuffer: 256 * 1024,
		});
		const parsed = JSON.parse(stdout) as TailscaleStatus;
		const dnsName = parsed.Self?.DNSName?.trim();
		if (dnsName) {
			return dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
		}
		const firstIp = parsed.Self?.TailscaleIPs?.find((value) => typeof value === "string");
		if (firstIp?.trim()) {
			return firstIp.trim();
		}
		return null;
	} catch {
		return null;
	}
}

async function hostFromIpFallback(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("tailscale", ["ip", "-4"], {
			timeout: 1500,
			maxBuffer: 64 * 1024,
		});
		const candidate = stdout
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		return candidate ?? null;
	} catch {
		return null;
	}
}
