import { describe, expect, it } from "vitest";
import { SpeechError } from "./types.js";
import { parsePlayableWav } from "./wav.js";

interface WavFixtureOptions {
	frames?: number;
	sampleRate?: number;
	channels?: number;
	bitsPerSample?: number;
	/** Declare a data size that differs from the bytes actually appended. */
	declaredDataSize?: number;
	/** An extra chunk written between `fmt ` and `data`. */
	extraChunk?: { id: string; size: number; body: Buffer };
	/** Omit the data chunk entirely. */
	omitData?: boolean;
}

function makeWav(options: WavFixtureOptions = {}): Buffer {
	const frames = options.frames ?? 2400;
	const sampleRate = options.sampleRate ?? 24000;
	const channels = options.channels ?? 1;
	const bitsPerSample = options.bitsPerSample ?? 16;
	const bytesPerFrame = (channels * bitsPerSample) / 8;
	const payload = Buffer.alloc(frames * bytesPerFrame);

	const fmt = Buffer.alloc(24);
	fmt.write("fmt ", 0, "ascii");
	fmt.writeUInt32LE(16, 4);
	fmt.writeUInt16LE(1, 8);
	fmt.writeUInt16LE(channels, 10);
	fmt.writeUInt32LE(sampleRate, 12);
	fmt.writeUInt32LE(sampleRate * bytesPerFrame, 16);
	fmt.writeUInt16LE(bytesPerFrame, 20);
	fmt.writeUInt16LE(bitsPerSample, 22);

	const parts: Buffer[] = [fmt];
	if (options.extraChunk) {
		const header = Buffer.alloc(8);
		header.write(options.extraChunk.id, 0, "ascii");
		header.writeUInt32LE(options.extraChunk.size, 4);
		parts.push(header, options.extraChunk.body);
	}
	if (!options.omitData) {
		const dataHeader = Buffer.alloc(8);
		dataHeader.write("data", 0, "ascii");
		dataHeader.writeUInt32LE(options.declaredDataSize ?? payload.length, 4);
		parts.push(dataHeader, payload);
	}

	const body = Buffer.concat(parts);
	const riff = Buffer.alloc(12);
	riff.write("RIFF", 0, "ascii");
	riff.writeUInt32LE(4 + body.length, 4);
	riff.write("WAVE", 8, "ascii");
	return Buffer.concat([riff, body]);
}

function expectRejection(buffer: Buffer, reason: string): void {
	try {
		parsePlayableWav(buffer);
	} catch (error) {
		expect(error).toBeInstanceOf(SpeechError);
		expect((error as SpeechError).code).toBe("empty_output");
		expect((error as SpeechError).message).toBe(reason);
		return;
	}
	throw new Error(`expected parsePlayableWav to reject with: ${reason}`);
}

describe("parsePlayableWav", () => {
	it("parses a 24 kHz mono 16-bit buffer", () => {
		const info = parsePlayableWav(makeWav({ frames: 2400 }));
		expect(info).toEqual({
			sampleRate: 24000,
			channels: 1,
			bitsPerSample: 16,
			frames: 2400,
			durationMs: 100,
		});
	});

	it("parses a file carrying an extra LIST chunk before data", () => {
		const info = parsePlayableWav(
			makeWav({
				frames: 1200,
				extraChunk: { id: "LIST", size: 8, body: Buffer.from("INFOhint") },
			}),
		);
		expect(info.frames).toBe(1200);
		expect(info.durationMs).toBe(50);
	});

	it("rejects an empty buffer", () => {
		expectRejection(Buffer.alloc(0), "output file is empty");
	});

	it("rejects a 12-byte buffer", () => {
		expectRejection(Buffer.alloc(12), "output is 12 bytes, too short to be a WAV");
	});

	it("rejects 64 bytes of zeroes", () => {
		expectRejection(Buffer.alloc(64), "output is not RIFF/WAVE");
	});

	it("rejects a header with a zero-length data chunk", () => {
		expectRejection(makeWav({ frames: 0 }), "WAV data chunk is empty");
	});

	it("rejects a file with no data chunk", () => {
		const buffer = makeWav({
			omitData: true,
			extraChunk: { id: "LIST", size: 12, body: Buffer.from("INFOhint1234") },
		});
		expect(buffer.length).toBeGreaterThanOrEqual(44);
		expectRejection(buffer, "WAV has no data chunk");
	});

	it("rejects a chunk table that steps past the buffer", () => {
		expectRejection(
			makeWav({ extraChunk: { id: "LIST", size: 1_000_000, body: Buffer.alloc(4) } }),
			"WAV chunk table is malformed",
		);
	});

	it("counts only the frames actually present when data is truncated", () => {
		const full = makeWav({ frames: 4, declaredDataSize: 1_000_000 });
		// 44-byte header plus the 8 bytes of payload that are really there.
		expect(full.length).toBe(52);
		const info = parsePlayableWav(full);
		expect(info.frames).toBe(4);
	});

	it("rejects a truncated file whose declared data has no bytes behind it", () => {
		const header = makeWav({ frames: 0, declaredDataSize: 1_000_000 });
		expectRejection(header, "WAV contains no audio frames");
	});
});
