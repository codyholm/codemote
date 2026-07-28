import { SpeechError } from "./types.js";

export interface WavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	frames: number;
	durationMs: number;
}

interface FmtChunk {
	channels: number;
	sampleRate: number;
	bitsPerSample: number;
}

function reject(reason: string): never {
	throw new SpeechError("empty_output", reason);
}

/**
 * Validates that a buffer is a playable WAV carrying at least one audio frame.
 *
 * A zero exit code from a synthesis engine is not evidence that audio exists;
 * this is the check that turns "the process succeeded" into "there are frames".
 */
export function parsePlayableWav(buffer: Buffer): WavInfo {
	if (buffer.length === 0) {
		reject("output file is empty");
	}
	if (buffer.length < 44) {
		reject(`output is ${buffer.length} bytes, too short to be a WAV`);
	}
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		reject("output is not RIFF/WAVE");
	}

	let fmt: FmtChunk | null = null;
	let dataOffset = -1;
	let dataSize = -1;
	let offset = 12;

	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;

		if (id === "fmt " && body + 16 <= buffer.length) {
			fmt = {
				channels: buffer.readUInt16LE(body + 2),
				sampleRate: buffer.readUInt32LE(body + 4),
				bitsPerSample: buffer.readUInt16LE(body + 14),
			};
		}

		if (id === "data") {
			dataOffset = body;
			dataSize = size;
			break;
		}

		// Chunks are word-aligned: an odd size is followed by a pad byte.
		const next = body + size + (size % 2);
		if (next <= offset || next > buffer.length) {
			reject("WAV chunk table is malformed");
		}
		offset = next;
	}

	if (dataOffset < 0) {
		reject("WAV has no data chunk");
	}
	if (dataSize === 0) {
		reject("WAV data chunk is empty");
	}
	if (!fmt) {
		reject("WAV has no fmt chunk");
	}
	if (fmt.channels <= 0 || fmt.sampleRate <= 0 || fmt.bitsPerSample <= 0) {
		reject("WAV fmt chunk declares an invalid format");
	}

	const bytesPerFrame = (fmt.channels * fmt.bitsPerSample) / 8;
	if (bytesPerFrame < 1) {
		reject("WAV fmt chunk declares an invalid format");
	}

	// Clamp to the bytes actually present so a truncated file cannot report
	// frames it does not carry.
	const presentBytes = Math.min(dataSize, buffer.length - dataOffset);
	const frames = Math.floor(presentBytes / bytesPerFrame);
	if (frames < 1) {
		reject("WAV contains no audio frames");
	}

	return {
		sampleRate: fmt.sampleRate,
		channels: fmt.channels,
		bitsPerSample: fmt.bitsPerSample,
		frames,
		durationMs: Math.round((frames / fmt.sampleRate) * 1000),
	};
}
