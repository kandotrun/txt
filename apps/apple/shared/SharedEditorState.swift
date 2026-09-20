import Foundation
import TxtCore

/// Thread-safe snapshot shared between the main actor and the sync actor
/// (spec §9.5, §10.1).
///
/// The sync engine runs off the UI thread and needs two things synchronously:
/// the latest committed document and whether the editor is at an IME safe
/// point. Both are main-actor state, so they are mirrored here behind a lock
/// instead of being read across actor boundaries (which Swift 6 rejects, and
/// which would also risk reading a half-updated snapshot).
final class SharedEditorState: @unchecked Sendable {
    private let lock = NSLock()
    private var _document = DocumentModel.empty()
    private var _isSafePoint = true
    private var _isComposing = false

    var document: DocumentModel {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _document
        }
        set {
            lock.lock()
            _document = newValue
            lock.unlock()
        }
    }

    var isSafePoint: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _isSafePoint
        }
        set {
            lock.lock()
            _isSafePoint = newValue
            lock.unlock()
        }
    }

    var isComposing: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _isComposing
        }
        set {
            lock.lock()
            _isComposing = newValue
            _isSafePoint = !newValue
            lock.unlock()
        }
    }
}
