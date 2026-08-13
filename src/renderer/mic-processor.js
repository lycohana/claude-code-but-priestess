// AudioWorklet processor — captures mono float32 audio from the microphone
// stream and posts it to the main thread in 16kHz frames. Replaces the
// deprecated ScriptProcessorNode, which crashed in a hidden background window
// when combined with the native tray menu on Windows.
class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0]) {
      const channel = input[0];
      // Copy because the underlying buffer is reused by the audio engine.
      const copy = channel.slice(0);
      this.port.postMessage({ samples: copy }, [copy.buffer]);
    }
    return true; // keep the processor alive
  }
}

registerProcessor("mic-processor", MicProcessor);
