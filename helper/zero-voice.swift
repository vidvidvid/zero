// zero-voice — the native half of zero's voice memos.
//
// Two things live out here because the webview cannot host them: microphone
// capture (getUserMedia would want WKUIDelegate capture plumbing) and Apple's
// on-device SpeechAnalyzer, which is Swift-only and macOS 26+. Rust runs this
// as a sidecar and speaks a deliberately dull protocol — one JSON request line
// in on stdin, a stream of NDJSON events out on stdout — so the parent never
// has to parse anything harder than a line.
//
//   zero-voice probe       {"locale":"en-US"}
//   zero-voice record      {"out":"/abs/…/stem.caf"}, then pause|resume|cancel|stop
//   zero-voice transcribe  {"audio":"/abs/…","locale":"en-US","contextual":[…],"out":"/abs/…/stem.raw.txt"}
//
// Exit 0 on success, 1 on failure with an `error` event as the last line.
// Built by scripts/build-helper.sh; the compiled binary is not committed.

import AVFoundation
import Foundation
import Speech

// MARK: - the wire

private let stdoutLock = NSLock()

/// stdout carries the event stream and nothing else — a stray `print` would
/// corrupt a line the parent is halfway through parsing. Everything human goes
/// to stderr via `note`.
///
/// Written with `write(2)` rather than FileHandle because a dead parent turns
/// stdout into a broken pipe, and FileHandle answers that with an Objective-C
/// exception Swift cannot catch. Here it is just a -1 we shrug at.
func emit(_ event: [String: Any]) {
    // Compact, and without the legal-but-unreadable `\/` escaping that would
    // otherwise turn every absolute path in this stream into noise.
    guard var line = try? JSONSerialization.data(withJSONObject: event, options: [.withoutEscapingSlashes])
    else { return }
    line.append(0x0A)
    stdoutLock.lock()
    line.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var sent = 0
        while sent < raw.count {
            let n = write(1, base.advanced(by: sent), raw.count - sent)
            if n < 0 && errno == EINTR { continue }  // a signal landed, not an answer —
            // giving up here would leave half a line for the next event to finish
            if n <= 0 { break }  // parent's gone; the work still finishes
            sent += n
        }
    }
    stdoutLock.unlock()
}

func note(_ message: String) {
    fputs("zero-voice: \(message)\n", stderr)
}

/// A rounded number that prints the way it was rounded. Foundation serialises a
/// Double at full precision, which turns a 1.6 second memo into
/// 1.6000000000000001 — true, and unreadable in a stream a person may end up
/// reading. Anything non-finite becomes zero rather than an unserialisable
/// object, because a dropped event is worse than a wrong one.
func number(_ value: Double, places: Int) -> NSDecimalNumber {
    guard value.isFinite else { return .zero }
    return NSDecimalNumber(string: String(format: "%.\(places)f", value))
}

/// The last event of a failed run and the exit code, in one place, so no path
/// can report a failure without also ending on one.
func fail(_ code: String, _ message: String) -> Never {
    emit(["event": "error", "code": code, "message": message])
    exit(1)
}

/// stdin is read through this one object because the two things we read it for
/// — the request line at startup and a later `stop` — would otherwise fight:
/// `readLine()` buffers through C stdio and would swallow bytes into a FILE*
/// that a raw fd read can never see again.
final class Stdin: @unchecked Sendable {
    private var pending = Data()
    private var closed = false

    /// Blocks until a whole line arrives. nil means end of input.
    func line() -> String? {
        while true {
            if let nl = pending.firstIndex(of: 0x0A) {
                let text = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
                pending.removeSubrange(pending.startIndex...nl)
                return text
            }
            if closed {
                guard !pending.isEmpty else { return nil }
                defer { pending.removeAll() }
                return String(decoding: pending, as: UTF8.self)
            }
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { closed = true } else { pending.append(chunk) }
        }
    }
}

func request(_ stdin: Stdin) -> [String: Any] {
    guard let line = stdin.line(),
          let data = line.data(using: .utf8),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
        fail("unsupported", "expected one JSON request object as the first line of stdin")
    }
    return object
}

// MARK: - probe

/// Answers the only three questions the panel needs before it dares show a
/// record button. Always exits 0: an unsupported machine is a fact, not a
/// failure.
func probe(_ req: [String: Any]) async {
    let wanted = Locale(identifier: (req["locale"] as? String) ?? "en-US")

    // The binary's own minimum is macOS 26 — below that it doesn't launch at
    // all, and the parent reads a helper that won't run as unsupported. What
    // `isAvailable` catches is the rest: a Mac with the OS but without the
    // transcriber.
    guard SpeechTranscriber.isAvailable else {
        emit(["event": "probe", "supported": false, "locale_supported": false, "asset_installed": false])
        return
    }

    let matched = await SpeechTranscriber.supportedLocale(equivalentTo: wanted)
    let installed = await SpeechTranscriber.installedLocales
    let tag = matched?.identifier(.bcp47)
    emit([
        "event": "probe",
        "supported": true,
        "locale_supported": matched != nil,
        "asset_installed": tag != nil && installed.contains { $0.identifier(.bcp47) == tag },
    ])
}

// MARK: - record

/// How a recording ended, and what that means for the bytes already on disk.
///
/// Everything that can stop one keeps them; `cancel` alone throws them away.
/// That single difference is the whole reason this is an enum rather than the
/// reason string it carries around for the log.
enum Ending {
    case keep(String)
    case discard

    var why: String {
        switch self {
        case .keep(let why): return why
        case .discard: return "cancel"
        }
    }
}

/// A recording ends five ways: a `stop` line, stdin closing, SIGTERM, the
/// half-hour cap, and a `cancel` line. Stdin closing is the load-bearing one —
/// it is how the parent dying reaches us, for free, with no heartbeat and no
/// pid file, whether it quit, crashed, or was kill -9'd. All five resolve this
/// gate, so the ending is decided once and can only be decided once, and the
/// two endings are written once each.
final class StopGate: @unchecked Sendable {
    private let lock = NSLock()
    private var fired: Ending?
    private var waiter: CheckedContinuation<Ending, Never>?

    func fire(_ ending: Ending) {
        lock.lock()
        guard fired == nil else { lock.unlock(); return }
        fired = ending
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume(returning: ending)
    }

    func wait() async -> Ending {
        await withCheckedContinuation { (continuation: CheckedContinuation<Ending, Never>) in
            lock.lock()
            if let fired {
                lock.unlock()
                continuation.resume(returning: fired)
                return
            }
            waiter = continuation
            lock.unlock()
        }
    }
}

enum RecorderError: Error {
    case device(String)
    case disk(String)
}

final class Recorder: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let gate: StopGate
    private let cafURL: URL
    private let target: AVAudioFormat

    /// The tap thread writes and the finalize path closes; this keeps them from
    /// meeting. `file` going nil is how "closed" is spelled — AVAudioFile has no
    /// close, it flushes its header when the last reference dies.
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var frames: AVAudioFramePosition = 0
    private var writeFailed = false
    private var lastLevel = 0.0
    /// nothing is written and nothing is reported while this is true. The
    /// engine is paused as well, so in practice no buffer arrives to be
    /// dropped — this is what makes the ones already in flight harmless.
    private var paused = false

    init(out: URL, gate: StopGate) throws {
        self.gate = gate
        self.cafURL = out

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw RecorderError.device("no usable audio input device")
        }

        // CAF, not m4a, and written buffer by buffer as they arrive rather than
        // held in memory. A CAF truncated at any byte is still a valid CAF — its
        // data chunk says "read to the end of the file" — so a crash mid-memo
        // costs a fraction of a second. An m4a cut before its moov atom lands is
        // simply gone, and losing a fifteen-minute ramble is the one failure
        // this feature is not allowed to have.
        //
        // Mono at the input's own rate: speech, and no resampler in the path.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: inputFormat.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        do {
            try FileManager.default.createDirectory(
                at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
            // Buffers are handed over as float32 and land as int16: AVAudioFile
            // does that conversion itself, which is one fewer thing to get wrong.
            let opened = try AVAudioFile(
                forWriting: out, settings: settings, commonFormat: .pcmFormatFloat32,
                interleaved: false)
            file = opened
            target = opened.processingFormat
        } catch {
            throw RecorderError.disk("could not open \(out.path) for writing: \(error.localizedDescription)")
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
    }

    func start() throws {
        do {
            try engine.start()
        } catch {
            throw RecorderError.device("could not start audio capture: \(error.localizedDescription)")
        }
    }

    /// Every tap buffer: mix to mono, write it, and occasionally say how loud it
    /// was.
    private func consume(_ buffer: AVAudioPCMBuffer) {
        guard let mono = mixdown(buffer) else { return }

        lock.lock()
        // A buffer the tap had already been handed when the pause landed. The
        // engine stops delivering them a moment after the verb arrives, and a
        // paused recording that grew by another few milliseconds — or lit the
        // level dot once more — would be a pause that didn't quite mean it.
        let ignore = paused
        if !ignore, let file {
            do {
                try file.write(from: mono)
                frames += AVAudioFramePosition(mono.frameLength)
            } catch {
                // Out of disk, almost certainly. Stop asking: the bytes already
                // written are a valid recording and worth more than an error.
                writeFailed = true
                self.file = nil
            }
        }
        let stopNow = writeFailed
        lock.unlock()

        if stopNow {
            gate.fire(.keep("write failed"))
            return
        }
        guard !ignore else { return }
        report(level: mono)
    }

    /// Stop capturing without closing anything down.
    ///
    /// The frames already written stay exactly where they are, the CAF stays
    /// open, and a resume appends to it — so a pause costs no bytes and no
    /// seconds, the duration being counted from frames that only exist while
    /// this is false.
    ///
    /// Pausing twice is a button pressed twice: the second one says nothing at
    /// all, so the parent can count one `paused` event per pause and keep its
    /// timer bookkeeping on that.
    func pause() {
        lock.lock()
        let already = paused
        paused = true
        lock.unlock()
        guard !already else { return }
        // the flag first, so a buffer already in flight is dropped rather than
        // written; the engine second, so the mic stops doing the work at all
        engine.pause()
        emit(["event": "paused"])
    }

    /// Pick the same file back up. `start` after `pause` resumes the graph the
    /// tap is still installed on, so the next buffer lands in the CAF exactly
    /// where the last one left off — one file, one recording, with a hole in
    /// the wall-clock time it took and none in the audio.
    func resume() {
        lock.lock()
        let wasPaused = paused
        paused = false
        lock.unlock()
        guard wasPaused else { return }
        do {
            try engine.start()
        } catch {
            // The input went away while we weren't listening — an interface
            // unplugged mid-pause, most likely. There is nothing to resume
            // into, so the recording ends the way a `stop` would: what was
            // captured is kept, and the parent hears `stopped`, which is the
            // truth about it.
            note("could not resume capture: \(error.localizedDescription)")
            gate.fire(.keep("resume failed"))
            return
        }
        emit(["event": "resumed"])
    }

    /// How much audio is actually on disk, in seconds. What the cap counts and
    /// what `finalize` reports, from one place, so that a paused hour can never
    /// be mistaken for a recorded one.
    func recorded() -> Double {
        lock.lock()
        let written = frames
        lock.unlock()
        return seconds(written)
    }

    private func seconds(_ frames: AVAudioFramePosition) -> Double {
        target.sampleRate > 0 ? Double(frames) / target.sampleRate : 0
    }

    /// AVAudioEngine hands every tap a deinterleaved float32 buffer, so the
    /// mixdown is an average across channels — no converter, no resampling, and
    /// a single code path whether the interface is a built-in mic or an eight
    /// channel box.
    private func mixdown(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let source = buffer.floatChannelData, buffer.frameLength > 0,
              let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: buffer.frameLength),
              let destination = out.floatChannelData
        else { return nil }

        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        let scale = 1 / Float(channels)
        for frame in 0..<frames {
            var sum: Float = 0
            for channel in 0..<channels { sum += source[channel][frame] }
            destination[0][frame] = sum * scale
        }
        out.frameLength = buffer.frameLength
        return out
    }

    private func report(level buffer: AVAudioPCMBuffer) {
        // The dot this drives is insurance against rambling fifteen minutes into
        // a muted input, so it needs to look alive, not accurate. Eight updates a
        // second is past the point the eye can tell them apart.
        let now = CFAbsoluteTimeGetCurrent()
        lock.lock()
        let due = now - lastLevel >= 0.125
        if due { lastLevel = now }
        lock.unlock()
        guard due, let samples = buffer.floatChannelData else { return }

        let frames = Int(buffer.frameLength)
        var sum: Float = 0
        for frame in 0..<frames { sum += samples[0][frame] * samples[0][frame] }
        let rms = Double((sum / Float(frames)).squareRoot())

        // Ordinary speech is around 0.02 RMS, so a brightness that tracked it
        // linearly would never light up. dBFS across a 60 dB window is what a
        // level meter actually shows, so that is what the parent gets.
        let db = 20 * log10(max(rms, 1e-6))
        let normalized = min(max((db + 60) / 60, 0), 1)
        emit(["event": "level", "rms": number(normalized, places: 3)])
    }

    /// The keeping ending, and the only one there is: every way a recording can
    /// stop but `cancel` arrives here. Close the CAF, turn it into an m4a a
    /// fraction of the size, and tell the parent where the audio actually ended
    /// up — which is the CAF itself if the encoder let us down, because a large
    /// honest file beats a lost memo.
    ///
    /// The duration is the frames that were written divided by the rate they
    /// were written at, which is why a pause costs nothing here: a stretch
    /// nobody recorded contributed no frames, and wall-clock time is never
    /// consulted. Arriving here paused is the ordinary case of stopping without
    /// resuming first, and needs nothing of its own.
    func finalize() -> Never {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        lock.lock()
        let written = frames
        let broke = writeFailed
        file = nil
        lock.unlock()

        let duration = seconds(written)

        if written == 0 && broke {
            try? FileManager.default.removeItem(at: cafURL)
            fail("disk_full", "the recording could not be written to \(cafURL.path)")
        }

        let m4a = encode(caf: cafURL)
        if m4a != nil {
            try? FileManager.default.removeItem(at: cafURL)
        }
        emit([
            "event": "stopped",
            "duration_s": number(duration, places: 1),
            "audio": (m4a ?? cafURL).path,
            "converted": m4a != nil,
        ])
        exit(0)
    }

    /// The other ending: everything `finalize` does to keep a recording, done
    /// to be rid of one.
    ///
    /// No `stopped` event and no m4a, because there is no audio left to point
    /// at or convert — a cancelled recording has to leave the directory exactly
    /// as it found it, or reconciliation would find bytes on disk and rebuild a
    /// memo out of the thing the user just threw away. Exit 0: being told to
    /// stop is not a failure.
    func discard() -> Never {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        lock.lock()
        // AVAudioFile flushes its header as the last reference dies; this one
        // dies over a file nobody will ever open
        file = nil
        lock.unlock()

        try? FileManager.default.removeItem(at: cafURL)
        // and the name the conversion would have used. `finalize` is the only
        // thing that ever writes it and the gate lets exactly one of us run, so
        // this is a failed unlink in every ordinary case — and the one line
        // that makes "a cancel leaves no audio behind" true of every name this
        // run could have written.
        try? FileManager.default.removeItem(at: Recorder.m4aURL(for: cafURL))
        emit(["event": "cancelled"])
        exit(0)
    }

    /// Where the conversion puts its output — `<stem>.m4a` beside the CAF. Both
    /// endings need to name it, so neither of them spells it.
    static func m4aURL(for caf: URL) -> URL {
        caf.deletingPathExtension().appendingPathExtension("m4a")
    }

    /// AAC-LC, 64 kbps, mono: about half a megabyte a minute against the ~86 MB
    /// of PCM a fifteen-minute memo makes. nil means the CAF stays and the parent
    /// is told so.
    private func encode(caf: URL) -> URL? {
        let m4a = Recorder.m4aURL(for: caf)
        // Encoded under a scratch name and renamed only after the writer has
        // closed. AVAudioFile writes the m4a's header when it closes, so a
        // crash mid-encode would otherwise leave a headerless file already
        // wearing the name every reader prefers over the caf it was made from
        // — an unplayable corpse shadowing a perfectly good recording. The
        // rename is the statement that the file is whole.
        let part = m4a.appendingPathExtension("part")
        do {
            try? FileManager.default.removeItem(at: part)
            let source = try AVAudioFile(forReading: caf)
            let format = source.processingFormat
            // an autoreleasepool so the writer is provably deallocated — and
            // its header provably on disk — before the rename that publishes it
            try autoreleasepool {
                let out = try AVAudioFile(
                    forWriting: part,
                    settings: [
                        AVFormatIDKey: kAudioFormatMPEG4AAC,
                        AVSampleRateKey: format.sampleRate,
                        AVNumberOfChannelsKey: format.channelCount,
                        AVEncoderBitRateKey: 64_000,
                    ])
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16384) else {
                    throw RecorderError.disk("could not allocate a conversion buffer")
                }
                // Bounded by framePosition, not by a short read: AVAudioFile throws
                // when asked to read at the end of a file rather than handing back
                // zero frames, so a `while true` here would turn every successful
                // conversion into a failure on its last lap.
                while source.framePosition < source.length {
                    try source.read(into: buffer)
                    if buffer.frameLength == 0 { break }
                    try out.write(from: buffer)
                }
            }
            try? FileManager.default.removeItem(at: m4a)
            try FileManager.default.moveItem(at: part, to: m4a)
            return m4a
        } catch {
            note("m4a conversion failed, keeping the caf: \(error.localizedDescription)")
            try? FileManager.default.removeItem(at: part)
            try? FileManager.default.removeItem(at: m4a)
            return nil
        }
    }
}

func record(_ req: [String: Any], stdin: Stdin) async -> Never {
    guard let out = req["out"] as? String, out.hasPrefix("/") else {
        fail("unsupported", "record needs an absolute \"out\" path")
    }

    // Permission first, and before any file exists: a denied mic must not leave
    // a zero-byte memo behind for reconciliation to puzzle over later.
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        break
    case .notDetermined:
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            fail("mic_denied", "microphone access was denied")
        }
    default:
        fail(
            "mic_denied",
            "microphone access is off for zero in System Settings › Privacy & Security › Microphone")
    }

    let gate = StopGate()
    let recorder: Recorder
    do {
        recorder = try Recorder(out: URL(fileURLWithPath: out), gate: gate)
    } catch RecorderError.device(let why) {
        fail("device_unavailable", why)
    } catch RecorderError.disk(let why) {
        fail("disk_full", why)
    } catch {
        fail("device_unavailable", error.localizedDescription)
    }

    // Stop path one and two, on a thread of their own because the read blocks:
    // `stop` is the polite verb, and a zero-length read means the pipe closed,
    // which means the parent is gone. They mean exactly the same thing here.
    //
    // The other three verbs are the panel's transport controls. Only `cancel`
    // ends anything, and it is the one ending that keeps nothing; `pause` and
    // `resume` are answered on this thread and the loop goes back to reading,
    // because a paused recording is still a recording.
    let watcher = Thread {
        while let line = stdin.line() {
            switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
            case "stop":
                gate.fire(.keep("stop"))
                return
            case "cancel":
                gate.fire(.discard)
                return
            case "pause":
                recorder.pause()
            case "resume":
                recorder.resume()
            // a word from a parent newer than this helper. Ignored rather than
            // fatal: nothing an unknown verb could mean is worth ending a
            // recording somebody is still talking into.
            default:
                break
            }
        }
        gate.fire(.keep("stdin closed"))
    }
    watcher.name = "zero-voice.stdin"
    watcher.start()

    // Stop path three. The default disposition has to be turned off first or the
    // signal kills the process before the source ever runs; the handler then
    // arrives on an ordinary queue, where doing real work is allowed. SIGINT is
    // handled the same way so a helper run by hand and interrupted still leaves
    // a finished file behind.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    sigterm.setEventHandler { gate.fire(.keep("SIGTERM")) }
    sigint.setEventHandler { gate.fire(.keep("SIGINT")) }
    sigterm.resume()
    sigint.resume()

    // Stop path four: a mic somebody forgot about is a privacy problem, not a
    // feature, and nothing in this workflow comes near half an hour.
    //
    // Counted in recorded seconds rather than wall-clock ones, because the mic
    // is off for every second of a pause and there is nothing about a recording
    // paused over lunch to be alarmed about. Each lap sleeps out whatever is
    // still owed, so half an hour of audio costs exactly one lap when nobody
    // pauses, and one more per pause when somebody does.
    let cap = Task {
        while !Task.isCancelled {
            let owed = Double(30 * 60) - recorder.recorded()
            if owed <= 0 {
                gate.fire(.keep("30-minute cap"))
                return
            }
            try? await Task.sleep(for: .seconds(max(owed, 1)))
        }
    }

    do {
        try recorder.start()
    } catch {
        // Not a single frame was captured, so leave nothing behind for
        // reconciliation to find and wonder about.
        try? FileManager.default.removeItem(at: URL(fileURLWithPath: out))
        if case RecorderError.device(let why) = error { fail("device_unavailable", why) }
        fail("device_unavailable", error.localizedDescription)
    }
    emit(["event": "recording"])

    let ending = await gate.wait()
    note("stopping: \(ending.why)")
    sigterm.cancel()
    sigint.cancel()
    cap.cancel()
    switch ending {
    case .keep: recorder.finalize()
    case .discard: recorder.discard()
    }
}

// MARK: - transcribe

func transcribe(_ req: [String: Any]) async {
    guard let audioPath = req["audio"] as? String, let outPath = req["out"] as? String else {
        fail("unsupported", "transcribe needs an \"audio\" and an \"out\" path")
    }
    let requested = Locale(identifier: (req["locale"] as? String) ?? "en-US")
    let contextual = ((req["contextual"] as? [String]) ?? []).filter { !$0.isEmpty }

    guard SpeechTranscriber.isAvailable else {
        fail("unsupported", "this Mac has no on-device speech transcriber")
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
        fail(
            "locale_unsupported",
            "\(requested.identifier(.bcp47)) is not one of the locales macOS transcribes on device")
    }

    let audio: AVAudioFile
    do {
        audio = try AVAudioFile(forReading: URL(fileURLWithPath: audioPath))
    } catch {
        fail("decode_failed", "could not read \(audioPath): \(error.localizedDescription)")
    }

    // The file preset, not a progressive one: nobody is reading this as it goes,
    // so there is no reason to pay for volatile results that get replaced.
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)

    // The models belong to the OS, not to us — usually already on the machine
    // because system dictation uses the same ones. When they aren't, this is the
    // single moment the feature touches the network, and the parent shows a
    // "downloading speech model…" state for exactly this event.
    //
    // `installedLocales` is the gate rather than `AssetInventory.status` or a nil
    // installation request: both of those still report work to do for a locale
    // that transcribes instantly, and announcing a download on every memo would
    // teach the user to ignore the one time it means something. It is also the
    // signal `probe` reports, so the two subcommands agree on what installed
    // means.
    let installed = await SpeechTranscriber.installedLocales
    let tag = locale.identifier(.bcp47)
    if !installed.contains(where: { $0.identifier(.bcp47) == tag }) {
        emit(["event": "assets_installing"])
        do {
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await install.downloadAndInstall()
            }
        } catch {
            fail(
                "asset_missing",
                "the \(tag) speech model isn't installed and couldn't be downloaded: \(error.localizedDescription)"
            )
        }
        // the other end of that wait — the parent gave the download a clock of
        // its own, and this is what hands the transcription a fresh one
        emit(["event": "assets_installed"])
    }

    // The clock starts after the download, not before: a first-run model fetch on
    // a slow connection is slow for an honest reason, and calling that a wedged
    // transcription would be a lie. Ten minutes of *analysis* is many times what
    // a long memo needs on Apple silicon.
    let deadline = Task {
        try? await Task.sleep(for: .seconds(600))
        if !Task.isCancelled {
            fail("decode_failed", "transcription did not finish within ten minutes")
        }
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])

    // Contextual strings are biasing layer one: they help the recogniser hear
    // "Anthropic" rather than "entropic". They cannot fix TRMNL, which really is
    // pronounced "terminal" — only the cleanup pass knows which one was meant —
    // so if this ever stops being expressible, losing it quietly is right.
    if !contextual.isEmpty {
        let context = AnalysisContext()
        context.contextualStrings[.general] = Array(contextual.prefix(200))
        try? await analyzer.setContext(context)
    }

    // Results have to be drained while the analysis runs; the module publishes as
    // it goes and collecting afterwards would wait on a sequence nobody is
    // feeding. Chunks are trimmed and rejoined with single spaces so the
    // transcript reads as prose rather than as concatenated fragments.
    let collector = Task { () -> String in
        var pieces: [String] = []
        for try await result in transcriber.results where result.isFinal {
            let piece = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !piece.isEmpty { pieces.append(piece) }
        }
        return pieces.joined(separator: " ")
    }

    do {
        if let end = try await analyzer.analyzeSequence(from: audio) {
            try await analyzer.finalizeAndFinish(through: end)
        } else {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        }
    } catch {
        collector.cancel()
        fail("decode_failed", "transcription failed: \(error.localizedDescription)")
    }

    let text: String
    do {
        text = try await collector.value
    } catch {
        fail("decode_failed", "transcription failed: \(error.localizedDescription)")
    }
    deadline.cancel()

    do {
        let url = URL(fileURLWithPath: outPath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    } catch {
        fail("disk_full", "could not write \(outPath): \(error.localizedDescription)")
    }

    // Zero characters is a memo of somebody not talking, which is a fact about
    // the audio, not a failure of this program.
    emit(["event": "done", "chars": text.count])
}

// MARK: - main

@main
struct ZeroVoice {
    static func main() async {
        // A parent that dies mid-event turns stdout into a broken pipe; without
        // this the default SIGPIPE would kill us before finalize could finish.
        signal(SIGPIPE, SIG_IGN)

        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else {
            fail("unsupported", "usage: zero-voice <probe|record|transcribe>, one JSON request line on stdin")
        }
        let stdin = Stdin()
        switch arguments[1] {
        case "probe": await probe(request(stdin))
        case "record": await record(request(stdin), stdin: stdin)
        case "transcribe": await transcribe(request(stdin))
        default: fail("unsupported", "unknown subcommand \"\(arguments[1])\"")
        }
    }
}
