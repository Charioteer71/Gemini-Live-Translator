/**
 * Gemini Live Translator - AudioWorklet Capture Processor
 * Runs off the main thread to accumulate 128-sample Web Audio frames into
 * 2048-sample mono blocks and transfer them to content.js for 16kHz resampling.
 */

class GeminiLiveAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunkSize = 2048;
    this._buffer = new Float32Array(this._chunkSize);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (!input || !input.length) return true;

    let readIdx = 0;
    while (readIdx < input.length) {
      const space = this._chunkSize - this._offset;
      const copyCount = Math.min(space, input.length - readIdx);
      this._buffer.set(input.subarray(readIdx, readIdx + copyCount), this._offset);
      this._offset += copyCount;
      readIdx += copyCount;

      if (this._offset >= this._chunkSize) {
        const out = this._buffer;
        this.port.postMessage(out, [out.buffer]);
        this._buffer = new Float32Array(this._chunkSize);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('gemini-live-audio-processor', GeminiLiveAudioProcessor);
