import AppKit
import SwiftUI

struct SidebarView: View {
    @ObservedObject var ui: NativeUI

    var body: some View {
        Group {
            if let state = ui.sidebar {
                if state.settings {
                    SettingsSidebar(ui: ui, state: state)
                } else {
                    ChatsSidebar(ui: ui, state: state)
                        .id(ui.page)
                }
            } else {
                Color.clear
            }
        }
        .overlay {
            if ui.covered {
                Scrim { ui.dismissCover() }
                    .ignoresSafeArea()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: ui.covered)
        // While the page covers the window its toolbar steps aside, as the iPhone's chrome does, the sidebar's toggle too.
        .toolbar(removing: ui.covered ? .sidebarToggle : nil)
    }
}

// MARK: Chats

private struct ChatsSidebar: View {
    @Environment(\.chromeScale) private var s
    @ObservedObject var ui: NativeUI
    let state: SidebarState

    @State private var query = ""
    @State private var selection: String?
    @FocusState private var searching: Bool

    private var activeRow: String? { state.rows.first(where: { $0.active })?.id }

    // The search above the list and you below it, never over it: rows passing under them would show through the glass.
    var body: some View {
        VStack(spacing: 0) {
            header
            list
            footer
        }
    }

    private var list: some View {
        List(selection: $selection) {
            if !state.loaded {
                ForEach(0..<4, id: \.self) { _ in
                    HStack(spacing: 10) {
                        Circle().fill(Theme.muted.opacity(0.15)).frame(width: 40, height: 40)
                        RoundedRectangle(cornerRadius: 4).fill(Theme.muted.opacity(0.15)).frame(height: 12)
                    }
                    .padding(.vertical, 4)
                    .selectionDisabled()
                }
            } else if state.empty {
                empty
            } else {
                if !state.pinned.isEmpty && query.isEmpty {
                    PinnedGrid(ui: ui, tiles: state.pinned)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                        .selectionDisabled()
                }
                if let look = state.look, query.isEmpty {
                    Button { ui.sendSidebar(["type": "look"]) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "sparkles").foregroundStyle(Theme.muted)
                            Text(look.label).font(.system(size: 13 * s, weight: .medium)).lineLimit(1)
                            Spacer(minLength: 4)
                            if look.count > 0 {
                                Text("\(look.count)")
                                    .font(.system(size: 11 * s, weight: .semibold).monospacedDigit())
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(Capsule().fill(Theme.muted.opacity(0.18)))
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .selectionDisabled()
                    .accessibilityIdentifier("sidebar.look")
                }
                ForEach(state.rows) { row in
                    SidebarRowView(row: row, face: ui.sidebarFace(row.face))
                        .tag(row.id)
                        .contextMenu { ItemsMenu(groups: row.menu) { id in ui.sendSidebar(["type": "row-menu", "thread": row.id, "id": id]) } }
                }
                if !query.isEmpty && state.rows.isEmpty && state.hits.isEmpty {
                    Text("Nothing matches.")
                        .font(.system(size: 12 * s))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .selectionDisabled()
                }
                if !state.hits.isEmpty {
                    Section("In messages") {
                        ForEach(state.hits) { hit in
                            HitView(hit: hit).tag("hit:" + hit.id)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .onAppear {
            query = state.query
            selection = activeRow
        }
        .onChange(of: activeRow) { selection = activeRow }
        .onChange(of: selection) { open(selection) }
        .onChange(of: query) {
            if query != state.query { ui.sendSidebar(["type": "search", "value": query]) }
        }
        .onChange(of: ui.searchRequest) { searching = true }
    }

    private func open(_ tag: String?) {
        guard let tag, tag != activeRow else { return }
        if tag.hasPrefix("hit:"), let hit = state.hits.first(where: { "hit:" + $0.id == tag }) {
            ui.sendSidebar(["type": "open", "path": hit.path])
            query = ""
        } else if let row = state.rows.first(where: { $0.id == tag }) {
            ui.sendSidebar(["type": "open", "path": row.path])
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.muted)
                TextField("Search", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .focused($searching)
                    .onSubmit(openFirst)
                    .onExitCommand { query = "" }
                    .accessibilityIdentifier("sidebar.search")
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain)
                    .help("Clear")
                    .accessibilityLabel("Clear")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .searchField()

            if !state.newItems.isEmpty {
                Menu {
                    ForEach(state.newItems) { item in
                        Button { ui.sendSidebar(["type": "new", "id": item.id]) } label: {
                            Label(item.label, systemImage: item.symbol)
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .medium))
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(width: 30, height: 30)
                .help("New")
                .accessibilityLabel("New")
                .accessibilityIdentifier("sidebar.new")
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private func openFirst() {
        if let row = state.rows.first {
            ui.sendSidebar(["type": "open", "path": row.path])
        } else if let hit = state.hits.first {
            ui.sendSidebar(["type": "open", "path": hit.path])
            query = ""
        }
    }

    private var empty: some View {
        VStack(spacing: 10) {
            BotFace(hex: 0x189C47).frame(width: 56, height: 56)
            Text("No bots yet").font(.system(size: 14, weight: .semibold))
            Text("Create one and give it a job.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Create your first bot") { ui.sendSidebar(["type": "new", "id": "new-bot"]) }
                .controlSize(.large)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .selectionDisabled()
    }

    private var footer: some View {
        MeButton(ui: ui, me: state.me, groups: state.profileMenu)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
    }
}

private struct PinnedGrid: View {
    @Environment(\.chromeScale) private var s
    @ObservedObject var ui: NativeUI
    let tiles: [SidebarState.Tile]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 80, maximum: 104), spacing: 4)], spacing: 6) {
            ForEach(tiles) { tile in
                Button { if !tile.active { ui.sendSidebar(["type": "open", "path": tile.path]) } } label: {
                    VStack(spacing: 5) {
                        FaceImage(image: ui.sidebarFace(tile.face), size: 64)
                            .overlay(alignment: .topTrailing) {
                                if !tile.active, let unread = tile.unread {
                                    UnreadDot(kind: unread, color: tile.color).frame(width: 10, height: 10)
                                }
                            }
                            .opacity(tile.working ? 0.85 : 1)
                        Text(tile.title)
                            .font(.system(size: 12 * s, weight: tile.active ? .semibold : .regular))
                            .foregroundStyle(tile.active ? Theme.foreground : Theme.muted)
                            .lineLimit(1)
                    }
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(tile.active ? Theme.muted.opacity(0.16) : .clear))
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .contextMenu { ItemsMenu(groups: tile.menu) { id in ui.sendSidebar(["type": "row-menu", "thread": tile.id, "id": id]) } }
                .accessibilityLabel(tile.title)
                .accessibilityIdentifier("sidebar.row.\(tile.id)")
            }
        }
        .padding(.horizontal, 4)
    }
}

private struct SidebarRowView: View {
    @Environment(\.chromeScale) private var s
    let row: SidebarState.Row
    let face: NSImage?

    var body: some View {
        HStack(spacing: 10) {
            FaceImage(image: face, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(row.title)
                        .font(.system(size: 13 * s, weight: .semibold))
                        .lineLimit(1)
                        .layoutPriority(1)
                    if !row.job.isEmpty {
                        Text(row.job)
                            .font(.system(size: 11 * s))
                            .foregroundStyle(Theme.ash)
                            .lineLimit(1)
                    }
                    if row.pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 8 * s))
                            .foregroundStyle(Theme.muted)
                            .accessibilityLabel("Pinned")
                    }
                    Spacer(minLength: 4)
                    if !row.time.isEmpty {
                        Text(row.time)
                            .font(.system(size: 11 * s))
                            .foregroundStyle(Theme.ash)
                            .fixedSize()
                    }
                }
                HStack(spacing: 6) {
                    preview
                    Spacer(minLength: 0)
                    if !row.active, let unread = row.unread {
                        UnreadDot(kind: unread, color: row.color).frame(width: 8, height: 8)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sidebar.row.\(row.id)")
    }

    @ViewBuilder
    private var preview: some View {
        let font = Font.system(size: 12 * s)
        switch row.previewKind {
        case "draft":
            HStack(spacing: 0) {
                Text("Draft: ").font(font.weight(.medium)).foregroundStyle(Theme.foreground).fixedSize()
                Text(row.preview).font(font).foregroundStyle(Theme.muted).lineLimit(1)
            }
        case "working":
            Text(row.preview).font(font).italic().foregroundStyle(Theme.muted).lineLimit(1)
        default:
            Text(row.preview).font(font).foregroundStyle(Theme.muted).lineLimit(1)
        }
    }
}

private struct HitView: View {
    @Environment(\.chromeScale) private var s
    let hit: SidebarState.Hit

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "text.bubble")
                .font(.system(size: 12))
                .foregroundStyle(Theme.muted)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(hit.title).font(.system(size: 12 * s, weight: .medium)).lineLimit(1)
                    Text(hit.time).font(.system(size: 11 * s)).foregroundStyle(Theme.ash).fixedSize()
                }
                Text(hit.snippet)
                    .font(.system(size: 12 * s))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

private struct UnreadDot: View {
    let kind: String
    let color: String

    var body: some View {
        Circle()
            .fill(kind == "team" ? Theme.ash : Color.css(color, or: Theme.foreground))
            .accessibilityLabel(kind == "team" ? "New between bots" : "Unread")
    }
}

struct FaceImage: View {
    let image: NSImage?
    let size: CGFloat

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
            } else {
                Circle().fill(Theme.muted.opacity(0.15))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct ItemsMenu: View {
    let groups: [[NativeMenuItem]]
    let pick: (String) -> Void

    var body: some View {
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
            Section {
                ForEach(group) { item in
                    Button(role: item.destructive ? .destructive : nil) { pick(item.id) } label: {
                        Label(item.label, systemImage: item.symbol)
                    }
                }
            }
        }
    }
}

private struct MeButton: View {
    @ObservedObject var ui: NativeUI
    let me: SidebarState.Me
    let groups: [[NativeMenuItem]]
    var marked = true

    var body: some View {
        Menu {
            ItemsMenu(groups: groups) { id in ui.sendSidebar(["type": "profile", "id": id]) }
        } label: {
            HStack(spacing: 8) {
                Group {
                    if let face = ui.sidebarFace(me.face) {
                        Image(nsImage: face).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
                    } else {
                        Text(me.initial)
                            .font(.system(size: 11, weight: .semibold))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Circle().fill(Theme.muted.opacity(0.2)))
                    }
                }
                .frame(width: 24, height: 24)
                .clipShape(Circle())
                Text(me.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Spacer(minLength: 4)
                if let profile = me.profile, !profile.isEmpty {
                    Text(profile).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 8)
            .frame(height: 36)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(me.active && marked ? Theme.muted.opacity(0.16) : .clear))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .accessibilityLabel("Your menu")
        .accessibilityIdentifier("sidebar.me")
    }
}

// MARK: Settings

private struct SettingsSidebar: View {
    @ObservedObject var ui: NativeUI
    let state: SidebarState
    @State private var selection: String?

    private static let back = "back"

    private var items: [SidebarState.SettingsItem] { state.sections.flatMap { $0.items } }
    private var active: String? { items.first(where: { $0.active })?.id }

    var body: some View {
        VStack(spacing: 0) {
            list
            // Settings' own section is the one marked, never you as well.
            MeButton(ui: ui, me: state.me, groups: state.profileMenu, marked: false)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
        }
    }

    private var list: some View {
        List(selection: $selection) {
            Label("Back to chats", systemImage: "chevron.left")
                .tag(Self.back)
                .accessibilityIdentifier("sidebar.back")
            ForEach(Array(state.sections.enumerated()), id: \.offset) { _, group in
                Section {
                    ForEach(group.items) { item in
                        Label(item.label, systemImage: item.symbol).tag(item.id)
                    }
                } header: {
                    if !group.label.isEmpty { Text(group.label) }
                }
            }
        }
        .listStyle(.sidebar)
        .onAppear { selection = active }
        .onChange(of: active) { selection = active }
        .onChange(of: selection) {
            guard let selection, selection != active else { return }
            if selection == Self.back {
                ui.sendSidebar(["type": "open", "path": "/app"])
            } else if let item = items.first(where: { $0.id == selection }) {
                ui.sendSidebar(["type": "open", "path": item.path])
            }
        }
    }
}

private extension View {
    @ViewBuilder
    func searchField() -> some View {
        if #available(macOS 26.0, *) {
            glassEffect(.regular, in: Capsule())
        } else {
            background(Color.primary.opacity(0.07), in: Capsule())
        }
    }
}
