import Foundation

/*
 * What the page hands the app as JSON (apps/web/lib/native-ui.ts): a conversation's toolbar and
 * composer (`chrome`) and the sidebar (`sidebar`). Every field is read leniently: one the page didn't
 * send, or sent as something else, falls back to its default instead of dropping the whole state, so
 * an older or newer page still draws.
 */

extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }

    func maybe<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

struct NativeMenuItem: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let symbol: String
    let destructive: Bool
}

extension NativeMenuItem {
    private enum Keys: String, CodingKey { case id, label, symbol, destructive }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        label = c.value(.label, "")
        symbol = c.value(.symbol, "")
        destructive = c.value(.destructive, false)
    }
}

// MARK: A conversation's toolbar and composer

struct ChromeState: Decodable, Equatable {
    struct Composer: Decodable, Equatable {
        let text: String
        let textRev: Int
        let focusRev: Int
        let placeholder: String
        let canSend: Bool
        let sending: Bool
        let later: Bool

        static let none = Composer(text: "", textRev: 0, focusRev: 0, placeholder: "", canSend: false, sending: false, later: false)
    }

    struct Mention: Decodable, Equatable, Identifiable {
        let id: String
        let handle: String
        let face: String?
    }

    struct File: Decodable, Equatable {
        let name: String
        let size: String
    }

    struct Replying: Decodable, Equatable {
        let name: String
        let color: String
        let text: String
    }

    struct Screen: Decodable, Equatable, Identifiable {
        let id: String
        let label: String
    }

    /// Where the page's conversation column is across the web view, in CSS pixels, when it says so;
    /// without it the composer is centred, as the column is while no panel sits beside it.
    struct Column: Decodable, Equatable {
        let x: Double
        let width: Double
    }

    let thread: String
    let title: String
    let subtitle: String
    let working: Bool
    let faces: [String]
    let more: Int
    let primary: Bool
    let tint: String
    let menu: [[NativeMenuItem]]
    let covered: Bool
    let mentions: [Mention]
    let files: [File]
    let replying: Replying?
    let jump: Bool
    let screens: [Screen]
    let column: Column?
    let composer: Composer
}

extension ChromeState {
    private enum Keys: String, CodingKey {
        case thread, title, subtitle, working, faces, more, primary, tint, menu, covered, mentions, files, replying, jump, screens, column, composer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // Without a conversation it isn't a conversation's chrome (a phone's Chats header, say).
        thread = try c.decode(String.self, forKey: .thread)
        title = c.value(.title, "")
        subtitle = c.value(.subtitle, "")
        working = c.value(.working, false)
        faces = c.value(.faces, [String]())
        more = c.value(.more, 0)
        primary = c.value(.primary, false)
        tint = c.value(.tint, "")
        menu = c.value(.menu, [[NativeMenuItem]]())
        covered = c.value(.covered, false)
        mentions = c.value(.mentions, [Mention]())
        files = c.value(.files, [File]())
        replying = c.maybe(.replying)
        jump = c.value(.jump, false)
        screens = c.value(.screens, [Screen]())
        column = c.maybe(.column)
        composer = c.value(.composer, Composer.none)
    }
}

extension ChromeState.Composer {
    private enum Keys: String, CodingKey { case text, textRev, focusRev, placeholder, canSend, sending, later }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        text = c.value(.text, "")
        textRev = c.value(.textRev, 0)
        focusRev = c.value(.focusRev, 0)
        placeholder = c.value(.placeholder, "")
        canSend = c.value(.canSend, false)
        sending = c.value(.sending, false)
        later = c.value(.later, false)
    }
}

extension ChromeState.Mention {
    private enum Keys: String, CodingKey { case id, handle, face }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        handle = c.value(.handle, "")
        face = c.maybe(.face)
    }
}

extension ChromeState.File {
    private enum Keys: String, CodingKey { case name, size }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = c.value(.name, "")
        size = c.value(.size, "")
    }
}

extension ChromeState.Replying {
    private enum Keys: String, CodingKey { case name, color, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = c.value(.name, "")
        color = c.value(.color, "")
        text = c.value(.text, "")
    }
}

extension ChromeState.Screen {
    private enum Keys: String, CodingKey { case id, label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        label = c.value(.label, "")
    }
}

extension ChromeState.Column {
    private enum Keys: String, CodingKey { case x, width }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        x = try c.decode(Double.self, forKey: .x)
        width = try c.decode(Double.self, forKey: .width)
    }
}

// MARK: The sidebar

struct SidebarState: Decodable, Equatable {
    struct Row: Decodable, Equatable, Identifiable {
        let id: String
        let path: String
        let title: String
        let job: String
        let pinned: Bool
        let time: String
        let preview: String
        let previewKind: String
        /// "you" (the bot's colour), "team" (grey) or nil.
        let unread: String?
        let color: String
        let face: String
        let active: Bool
        let working: Bool
        let menu: [[NativeMenuItem]]
    }

    struct Tile: Decodable, Equatable, Identifiable {
        let id: String
        let path: String
        let title: String
        let face: String
        let active: Bool
        let working: Bool
        let unread: String?
        let color: String
        let menu: [[NativeMenuItem]]
    }

    struct Hit: Decodable, Equatable, Identifiable {
        let id: String
        let path: String
        let title: String
        let time: String
        let snippet: String
    }

    struct Look: Decodable, Equatable {
        let label: String
        let count: Int
    }

    struct Me: Decodable, Equatable {
        let name: String
        /// A key into the faces, or a picture's data URL; nil for the initial on a plain circle.
        let face: String?
        let initial: String
        /// The open profile's name when there are several.
        let profile: String?
        let active: Bool

        static let none = Me(name: "", face: nil, initial: "", profile: nil, active: false)
    }

    struct SettingsItem: Decodable, Equatable, Identifiable {
        let id: String
        let label: String
        let symbol: String
        let path: String
        let active: Bool
    }

    struct SettingsGroup: Decodable, Equatable {
        let label: String
        let items: [SettingsItem]
    }

    let mode: String
    let title: String
    let covered: Bool
    /// PNG data URLs by face key, only those the page hasn't sent before in its life.
    let faces: [String: String]
    let query: String
    let loaded: Bool
    let empty: Bool
    let pinned: [Tile]
    let rows: [Row]
    let hits: [Hit]
    let look: Look?
    let newItems: [NativeMenuItem]
    let me: Me
    let profileMenu: [[NativeMenuItem]]
    let sections: [SettingsGroup]

    var settings: Bool { mode == "settings" }
}

extension SidebarState {
    private enum Keys: String, CodingKey {
        case mode, title, covered, faces, query, loaded, empty, pinned, rows, hits, look, newItems, me, profileMenu, sections
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        mode = c.value(.mode, "chats")
        title = c.value(.title, "Gond")
        covered = c.value(.covered, false)
        faces = c.value(.faces, [String: String?]()).compactMapValues { $0 }
        query = c.value(.query, "")
        loaded = c.value(.loaded, true)
        empty = c.value(.empty, false)
        pinned = c.value(.pinned, [Tile]())
        rows = c.value(.rows, [Row]())
        hits = c.value(.hits, [Hit]())
        look = c.maybe(.look)
        newItems = c.value(.newItems, [NativeMenuItem]())
        me = c.value(.me, Me.none)
        profileMenu = c.value(.profileMenu, [[NativeMenuItem]]())
        sections = c.value(.sections, [SettingsGroup]())
    }
}

extension SidebarState.Row {
    private enum Keys: String, CodingKey { case id, path, title, job, pinned, time, preview, previewKind, unread, color, face, active, working, menu }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        path = c.value(.path, "/app/t/\(id)")
        title = c.value(.title, "")
        job = c.value(.job, "")
        pinned = c.value(.pinned, false)
        time = c.value(.time, "")
        preview = c.value(.preview, "")
        previewKind = c.value(.previewKind, "text")
        unread = c.maybe(.unread)
        color = c.value(.color, "")
        face = c.value(.face, "")
        active = c.value(.active, false)
        working = c.value(.working, false)
        menu = c.value(.menu, [[NativeMenuItem]]())
    }
}

extension SidebarState.Tile {
    private enum Keys: String, CodingKey { case id, path, title, face, active, working, unread, color, menu }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        path = c.value(.path, "/app/t/\(id)")
        title = c.value(.title, "")
        face = c.value(.face, "")
        active = c.value(.active, false)
        working = c.value(.working, false)
        unread = c.maybe(.unread)
        color = c.value(.color, "")
        menu = c.value(.menu, [[NativeMenuItem]]())
    }
}

extension SidebarState.Hit {
    private enum Keys: String, CodingKey { case id, path, title, time, snippet }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        path = try c.decode(String.self, forKey: .path)
        title = c.value(.title, "")
        time = c.value(.time, "")
        snippet = c.value(.snippet, "")
    }
}

extension SidebarState.Look {
    private enum Keys: String, CodingKey { case label, count }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        label = c.value(.label, "Worth a look")
        count = c.value(.count, 0)
    }
}

extension SidebarState.Me {
    private enum Keys: String, CodingKey { case name, face, initial, profile, active }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = c.value(.name, "")
        face = c.maybe(.face)
        initial = c.value(.initial, "")
        profile = c.maybe(.profile)
        active = c.value(.active, false)
    }
}

extension SidebarState.SettingsItem {
    private enum Keys: String, CodingKey { case id, label, symbol, path, active }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        path = try c.decode(String.self, forKey: .path)
        label = c.value(.label, "")
        symbol = c.value(.symbol, "")
        active = c.value(.active, false)
    }
}

extension SidebarState.SettingsGroup {
    private enum Keys: String, CodingKey { case label, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        label = c.value(.label, "")
        items = c.value(.items, [SidebarState.SettingsItem]())
    }
}

// MARK: What the page asks for (`present`)

struct ToastRequest: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let description: String
    let tone: String
}

extension ToastRequest {
    private enum Keys: String, CodingKey { case id, title, description, tone }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = c.value(.id, UUID().uuidString)
        title = c.value(.title, "")
        description = c.value(.description, "")
        tone = c.value(.tone, "info")
    }
}

struct MessageMenuRequest: Decodable {
    struct Rect: Decodable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    struct Reactions: Decodable {
        let options: [String]
        let mine: String?
    }

    let id: String
    let rect: Rect?
    let reactions: Reactions?
    let items: [NativeMenuItem]
}

extension MessageMenuRequest {
    private enum Keys: String, CodingKey { case id, rect, reactions, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        rect = c.maybe(.rect)
        reactions = c.maybe(.reactions)
        items = c.value(.items, [NativeMenuItem]())
    }
}

struct ConfirmRequest: Decodable {
    let id: String
    let title: String
    let message: String
    let action: String
    let destructive: Bool
}

extension ConfirmRequest {
    private enum Keys: String, CodingKey { case id, title, message, action, destructive }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.value(.title, "")
        message = c.value(.message, "")
        action = c.value(.action, "OK")
        destructive = c.value(.destructive, false)
    }
}

struct PicturesRequest: Decodable {
    struct Item: Decodable {
        let url: String
        let name: String
    }

    let id: String
    let items: [Item]
    let index: Int
}
