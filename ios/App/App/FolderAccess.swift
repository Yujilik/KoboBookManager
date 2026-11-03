import Foundation

/// Persistent, read-only access to folders chosen in the Files picker (the iOS counterpart of
/// Android's persisted document-tree permissions). The web app stores only opaque, stable URIs:
/// `ios-folder:<id>` for a folder and `ios-folder:<id>/<percent-encoded relative path>` for a file.
final class FolderAccess {
    struct Folder { let uri: String; let name: String }
    struct File { let uri: String; let name: String; let size: Int64; let modified: String }

    static let scheme = "ios-folder:"
    static let maxFile: Int64 = 192 * 1024 * 1024
    private let defaults: UserDefaults
    private let key = "KoboBookManager.folders"
    private let lock = NSLock()

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Persist access to a folder URL returned by the document picker.
    func register(_ url: URL) throws -> Folder {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let bookmark = try url.bookmarkData(options: Self.bookmarkOptions, includingResourceValuesForKeys: nil, relativeTo: nil)
        let path = url.standardizedFileURL.path
        lock.lock(); defer { lock.unlock() }
        var folders = stored()
        // Choosing the same folder again keeps its URI, as Android's tree URI does.
        let id = folders.first(where: { ($0.value["path"] as? String) == path })?.key ?? UUID().uuidString
        folders[id] = ["bookmark": bookmark, "path": path]
        defaults.set(folders, forKey: key)
        var name = FileManager.default.displayName(atPath: url.path)
        if name.isEmpty { name = url.lastPathComponent }
        if name.isEmpty { name = "Minha pasta" }
        return Folder(uri: Self.scheme + id, name: name)
    }

    /// Recursively list book candidates, matching the Android scan limits and filters.
    func scan(_ uri: String) throws -> [File] {
        let (id, relative) = try parse(uri)
        guard relative.isEmpty else { throw KoboError("Invalid folder URI") }
        return try withFolder(id) { root in
            var files: [File] = []
            try scan(root, root: root, id: id, files: &files, depth: 0)
            return files
        }
    }

    /// Read a scanned file, downloading it from iCloud/a file provider if necessary.
    func read(_ uri: String, limit: Int64 = FolderAccess.maxFile) throws -> Data {
        let (id, relative) = try parse(uri)
        guard !relative.isEmpty else { throw KoboError("Arquivo indisponível.") }
        return try withFolder(id) { root in
            let file = try resolve(relative, in: root)
            return try coordinatedRead(file) { url in
                guard let handle = try? FileHandle(forReadingFrom: url) else { throw KoboError("Arquivo indisponível.") }
                defer { try? handle.close() }
                var data = Data()
                while let chunk = try handle.read(upToCount: 32768), !chunk.isEmpty {
                    if Int64(data.count) + Int64(chunk.count) > limit { throw KoboError("fileTooLarge") }
                    data.append(chunk)
                }
                return data
            }
        }
    }

    // MARK: - Internals

    /// On iOS a bookmark created while a picker URL's security scope is active keeps that scope.
    private static let bookmarkOptions: URL.BookmarkCreationOptions = []

    private func stored() -> [String: [String: Any]] {
        (defaults.dictionary(forKey: key) as? [String: [String: Any]]) ?? [:]
    }

    private func parse(_ uri: String) throws -> (String, String) {
        guard uri.hasPrefix(Self.scheme) else { throw KoboError("Invalid folder URI") }
        let rest = uri.dropFirst(Self.scheme.count)
        guard let slash = rest.firstIndex(of: "/") else { return (String(rest), "") }
        return (String(rest[..<slash]), String(rest[rest.index(after: slash)...]))
    }

    private func withFolder<T>(_ id: String, _ body: (URL) throws -> T) throws -> T {
        lock.lock()
        let entry = stored()[id]
        lock.unlock()
        guard let bookmark = entry?["bookmark"] as? Data else { throw KoboError("Folder access expired") }
        var stale = false
        let url = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if stale, let fresh = try? url.bookmarkData(options: Self.bookmarkOptions, includingResourceValuesForKeys: nil, relativeTo: nil) {
            lock.lock()
            var folders = stored()
            folders[id] = ["bookmark": fresh, "path": url.standardizedFileURL.path]
            defaults.set(folders, forKey: key)
            lock.unlock()
        }
        return try body(url)
    }

    private func resolve(_ relative: String, in root: URL) throws -> URL {
        var url = root
        for part in relative.split(separator: "/", omittingEmptySubsequences: false) {
            guard let name = String(part).removingPercentEncoding, !name.isEmpty, name != ".", name != "..", !name.contains("/")
            else { throw KoboError("Arquivo indisponível.") }
            url.appendPathComponent(name)
        }
        return url
    }

    private static let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .totalFileSizeKey, .contentModificationDateKey,
                                                 .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]

    private func scan(_ directory: URL, root: URL, id: String, files: inout [File], depth: Int) throws {
        if depth > 12 || files.count > 10000 { throw KoboError("Pasta muito grande ou com muitas subpastas.") }
        let children = try coordinatedRead(directory) { url in
            try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: Self.keys, options: [])
        }.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        let base = directory.standardizedFileURL.pathComponents.count - root.standardizedFileURL.pathComponents.count
        let prefix = directory.standardizedFileURL.pathComponents.suffix(base)
        for child in children {
            let values = try? child.resourceValues(forKeys: Set(Self.keys))
            var name = child.lastPathComponent
            if values?.isDirectory == true && values?.isSymbolicLink != true {
                try scan(child, root: root, id: id, files: &files, depth: depth + 1)
                continue
            }
            // Legacy iCloud placeholders (".Book.epub.icloud") stand for files not yet downloaded.
            var placeholder = false
            if name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > 8 {
                name = String(name.dropFirst().dropLast(7)); placeholder = true
            }
            let fileURL = placeholder ? child.deletingLastPathComponent().appendingPathComponent(name) : child
            if name.isEmpty { name = "book" }
            let lower = name.lowercased()
            if !(lower.hasSuffix(".epub") || lower.hasSuffix(".pdf")) {
                // Some providers return no extension. Read only five bytes, then let the importer validate it.
                // Never download cloud-only files (photos, videos...) just to sniff their header.
                if placeholder || (values?.isUbiquitousItem == true && values?.ubiquitousItemDownloadingStatus != .current) { continue }
                guard (try? coordinatedRead(fileURL, { BookContent.candidate(file: $0) })) == true else { continue }
            }
            let encoded = (Array(prefix) + [name]).map { $0.addingPercentEncoding(withAllowedCharacters: Self.componentAllowed) ?? $0 }.joined(separator: "/")
            let size = Int64(values?.fileSize ?? values?.totalFileSize ?? 0)
            let modified = values?.contentModificationDate.map { String(Int64(($0.timeIntervalSince1970 * 1000).rounded(.down))) } ?? "0"
            files.append(File(uri: Self.scheme + id + "/" + encoded, name: name, size: size, modified: modified))
        }
    }

    private static let componentAllowed: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "/%")
        return set
    }()

    private func coordinatedRead<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
        var coordinatorError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinatorError) { readable in
            result = Result { try body(readable) }
        }
        if let result { return try result.get() }
        throw coordinatorError ?? KoboError("Arquivo indisponível.")
    }
}
