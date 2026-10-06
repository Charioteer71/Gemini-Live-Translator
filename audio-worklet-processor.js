/**
 * Gemini Live Translator - Audio Worklet Processor
 * Runs on the audio rendering thread at 16,000 Hz.
 * Converts 32-bit floating point audio samples to 16-bit linear PCM format,
 * grouping samples into 100ms frames (1600 samples) for Gemini Live streaming.
 */
class GeminiAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Default 1600 samples = 100ms frame at 16,000 Hz mono
    this._frameSize = options?.processorOptions?.frameSize || 1600;
    this._buffer = new Int16Array(this._frameSize);
    this._writePos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const len = channel.length;
    for (let i = 0; i < len; i++) {
      const s = channel[i];
      // Quantize float [-1.0, 1.0] to signed 16-bit PCM integer [-32768, 32767]
      this._buffer[this._writePos++] = s < -1 ? -32768 : s > 1 ? 32767 : (s * 32767) | 0;

      if (this._writePos >= this._frameSize) {
        this.port.postMessage(this._buffer.slice(0));
        this._writePos = 0;
      }
    }
    return true;
  }
}

registerProcessor('gemini-audio-processor', GeminiAudioProcessor);
