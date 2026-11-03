import Foundation
import CryptoKit

/// Validate staged exports before any picker, delivery session or success receipt.
enum ExportPayload {
    static let maxSize: Int64 = 512 * 1024 * 1024
    private static let epubMimetype = Array("application/epub+zip".utf8)
    private static let chunk = 32768

    struct Checked {
        let file: URL
        let mime: String
        let size: Int64
        let sha256: String
    }

    static func validate(cacheDirectory: URL, path: String?, name: String?, mime: String?, expectedSize: Int64, expectedHash: String?) throws -> Checked {
        guard let path, !path.isEmpty, !path.hasPrefix("/") else { throw KoboError("Missing or invalid staged path") }
        guard let name, !name.isEmpty, let mime else { throw KoboError("Missing output filename or MIME type") }
        let root = canonical(cacheDirectory)
        let file = canonical(root.appendingPathComponent(path))
        guard file.path.hasPrefix(root.path + "/") else { throw KoboError("Staged path is outside cache") }
        guard isFile(file) else { throw KoboError("Staged output is missing") }
        try verifyFile(file, expectedSize: expectedSize, expectedHash: expectedHash)
        let lower = name.lowercased()
        switch mime {
        case "application/pdf":
            guard lower.hasSuffix(".pdf") else { throw KoboError("PDF filename does not match output type") }
            let prefix = try readPrefix(file, count: 8)
            guard prefix.count == 8, let text = String(bytes: prefix, encoding: .ascii),
                  text.range(of: "^%PDF-[0-9]\\.[0-9]$", options: .regularExpression) != nil
            else { throw KoboError("Output is not a PDF") }
        case "application/epub+zip":
            guard lower.hasSuffix(".epub") else { throw KoboError("EPUB filename does not match output type") }
            try verifyZip(file, epub: true)
        case "application/zip":
            guard lower.hasSuffix(".zip") else { throw KoboError("ZIP filename does not match output type") }
            try verifyZip(file, epub: false)
        default:
            throw KoboError("Unsupported output MIME type")
        }
        return Checked(file: file, mime: mime, size: expectedSize, sha256: expectedHash!)
    }

    static func verifyFile(_ file: URL, expectedSize: Int64, expectedHash: String?) throws {
        guard isFile(file), fileLength(file) == expectedSize else { throw KoboError("Staged output length changed") }
        guard let input = InputStream(url: file) else { throw KoboError("Output cannot be read back") }
        try verifyStream(input, expectedSize: expectedSize, expectedHash: expectedHash)
    }

    static func verifyStream(_ input: InputStream?, expectedSize: Int64, expectedHash: String?) throws {
        guard let input else { throw KoboError("Output cannot be read back") }
        try checkMetadata(expectedSize, expectedHash)
        input.open(); defer { input.close() }
        var digest = SHA256()
        var buffer = [UInt8](repeating: 0, count: chunk)
        var total: Int64 = 0
        while true {
            let count = input.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw KoboError("Output cannot be read back") }
            if count == 0 { break }
            total += Int64(count)
            if total > expectedSize { throw KoboError("Output is longer than expected") }
            digest.update(data: buffer[0..<count])
        }
        if total != expectedSize { throw KoboError("Output is empty or truncated") }
        if hex(digest.finalize()) != expectedHash { throw KoboError("Output checksum mismatch") }
    }

    /// Caller must close the destination before reporting success, then read it back.
    static func copy(_ input: InputStream?, _ output: OutputStream?, expectedSize: Int64, expectedHash: String?) throws {
        guard let input, let output else { throw KoboError("Output destination is unavailable") }
        try checkMetadata(expectedSize, expectedHash)
        if input.streamStatus == .notOpen { input.open() }
        if output.streamStatus == .notOpen { output.open() }
        defer { input.close() }
        var digest = SHA256()
        var buffer = [UInt8](repeating: 0, count: chunk)
        var total: Int64 = 0
        while true {
            let count = input.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw KoboError("Staged output changed during save") }
            if count == 0 { break }
            total += Int64(count)
            if total > expectedSize { throw KoboError("Staged output grew during save") }
            var written = 0
            while written < count {
                let n = buffer.withUnsafeBufferPointer { output.write($0.baseAddress! + written, maxLength: count - written) }
                if n <= 0 { throw KoboError(output.streamError?.localizedDescription ?? "Output destination is unavailable") }
                written += n
            }
            digest.update(data: buffer[0..<count])
        }
        if total != expectedSize || hex(digest.finalize()) != expectedHash { throw KoboError("Staged output changed during save") }
    }

    static func sha256(of file: URL) throws -> String {
        guard let input = InputStream(url: file) else { throw KoboError("Output cannot be read back") }
        input.open(); defer { input.close() }
        var digest = SHA256()
        var buffer = [UInt8](repeating: 0, count: chunk)
        while true {
            let count = input.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw KoboError("Output cannot be read back") }
            if count == 0 { break }
            digest.update(data: buffer[0..<count])
        }
        return hex(digest.finalize())
    }

    // MARK: - Helpers

    static func canonical(_ url: URL) -> URL { url.standardizedFileURL.resolvingSymlinksInPath() }

    static func isFile(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && !directory.boolValue
    }

    static func fileLength(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? -1
    }

    private static func checkMetadata(_ size: Int64, _ hash: String?) throws {
        if size <= 0 || size > maxSize { throw KoboError("Output length is missing, zero or too large") }
        guard let hash, hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        else { throw KoboError("Output checksum is missing or invalid") }
    }

    static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        let alphabet = Array("0123456789abcdef")
        var output = ""
        for value in bytes { output.append(alphabet[Int(value >> 4)]); output.append(alphabet[Int(value & 15)]) }
        return output
    }

    private static func readPrefix(_ file: URL, count: Int) throws -> [UInt8] {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var data: [UInt8] = []
        while data.count < count, let part = try handle.read(upToCount: count - data.count), !part.isEmpty { data.append(contentsOf: part) }
        return data
    }

    private static func verifyZip(_ file: URL, epub: Bool) throws {
        let zip = try ZipReader(file)
        defer { zip.close() }
        guard zip.entries.contains(where: { !$0.isDirectory }) else { throw KoboError("Output ZIP is empty") }
        if !epub { return }
        guard let type = zip.entry("mimetype"), !type.isDirectory, type.size == UInt64(epubMimetype.count),
              let container = zip.entry("META-INF/container.xml"), !container.isDirectory,
              container.size > 0, container.size <= 1024 * 1024
        else { throw KoboError("Output is not an EPUB container") }
        guard try zip.read(type, limit: epubMimetype.count + 1) == epubMimetype else { throw KoboError("EPUB mimetype is invalid") }
        let contents = try zip.read(container, limit: 1024 * 1024 + 1)
        if contents.isEmpty || contents.count > 1024 * 1024 { throw KoboError("EPUB container is invalid") }
    }
}

/// Minimal read-only ZIP reader (central directory, ZIP64, stored and deflated entries).
final class ZipReader {
    struct Entry {
        let name: String
        let method: UInt16
        let flags: UInt16
        let compressedSize: UInt64
        let size: UInt64
        let localOffset: UInt64
        var isDirectory: Bool { name.hasSuffix("/") }
    }

    private let handle: FileHandle
    private let length: UInt64
    private(set) var entries: [Entry] = []

    init(_ file: URL) throws {
        handle = try FileHandle(forReadingFrom: file)
        do {
            length = try handle.seekToEnd()
            try readCentralDirectory()
        } catch {
            try? handle.close()
            throw error is KoboError ? error : KoboError("Output ZIP is invalid")
        }
    }

    func close() { try? handle.close() }

    func entry(_ name: String) -> Entry? { entries.first { $0.name == name } }

    /// Returns at most `limit` uncompressed bytes of the entry.
    func read(_ entry: Entry, limit: Int) throws -> [UInt8] {
        let local = try bytes(at: entry.localOffset, count: 30)
        guard u32(local, 0) == 0x04034b50 else { throw KoboError("Output ZIP is invalid") }
        let start = entry.localOffset + 30 + UInt64(u16(local, 26)) + UInt64(u16(local, 28))
        guard start <= length, entry.compressedSize <= length - start else { throw KoboError("Output ZIP is invalid") }
        switch entry.method {
        case 0:
            return try bytes(at: start, count: Int(min(entry.compressedSize, UInt64(limit))))
        case 8:
            guard entry.compressedSize <= 64 * 1024 * 1024 else { throw KoboError("Output ZIP is invalid") }
            let compressed = Data(try bytes(at: start, count: Int(entry.compressedSize)))
            guard let inflated = try? (compressed as NSData).decompressed(using: .zlib) as Data else { throw KoboError("Output ZIP is invalid") }
            return Array(inflated.prefix(limit))
        default:
            throw KoboError("Unsupported ZIP compression method")
        }
    }

    private func readCentralDirectory() throws {
        guard length >= 22 else { throw KoboError("Output ZIP is invalid") }
        let tailLength = Int(min(length, 22 + 65535))
        let tail = try bytes(at: length - UInt64(tailLength), count: tailLength)
        var eocd = -1
        var index = tail.count - 22
        while index >= 0 { if u32(tail, index) == 0x06054b50 { eocd = index; break }; index -= 1 }
        guard eocd >= 0 else { throw KoboError("Output ZIP is invalid") }
        var total = UInt64(u16(tail, eocd + 10))
        var size = UInt64(u32(tail, eocd + 12))
        var offset = UInt64(u32(tail, eocd + 16))
        let eocdPosition = length - UInt64(tailLength) + UInt64(eocd)
        if (total == 0xFFFF || size == 0xFFFF_FFFF || offset == 0xFFFF_FFFF), eocdPosition >= 20 {
            let locator = try bytes(at: eocdPosition - 20, count: 20)
            if u32(locator, 0) == 0x07064b50 {
                let record = try bytes(at: u64(locator, 8), count: 56)
                guard u32(record, 0) == 0x06064b50 else { throw KoboError("Output ZIP is invalid") }
                total = u64(record, 32); size = u64(record, 40); offset = u64(record, 48)
            }
        }
        guard offset <= length, size <= length - offset, size <= 64 * 1024 * 1024 else { throw KoboError("Output ZIP is invalid") }
        let directory = try bytes(at: offset, count: Int(size))
        var position = 0
        for _ in 0..<total {
            guard position + 46 <= directory.count, u32(directory, position) == 0x02014b50 else { throw KoboError("Output ZIP is invalid") }
            let nameLength = Int(u16(directory, position + 28)), extraLength = Int(u16(directory, position + 30)), commentLength = Int(u16(directory, position + 32))
            guard position + 46 + nameLength + extraLength + commentLength <= directory.count else { throw KoboError("Output ZIP is invalid") }
            let nameBytes = directory[(position + 46)..<(position + 46 + nameLength)]
            let name = String(decoding: nameBytes, as: UTF8.self)
            var usize = UInt64(u32(directory, position + 24)), csize = UInt64(u32(directory, position + 20)), local = UInt64(u32(directory, position + 42))
            var extra = position + 46 + nameLength
            let extraEnd = extra + extraLength
            while extra + 4 <= extraEnd {
                let id = u16(directory, extra), dataLength = Int(u16(directory, extra + 2))
                var field = extra + 4
                if id == 0x0001 {
                    if usize == 0xFFFF_FFFF, field + 8 <= extraEnd { usize = u64(directory, field); field += 8 }
                    if csize == 0xFFFF_FFFF, field + 8 <= extraEnd { csize = u64(directory, field); field += 8 }
                    if local == 0xFFFF_FFFF, field + 8 <= extraEnd { local = u64(directory, field) }
                }
                extra += 4 + dataLength
            }
            entries.append(Entry(name: name, method: u16(directory, position + 10), flags: u16(directory, position + 8),
                                 compressedSize: csize, size: usize, localOffset: local))
            position += 46 + nameLength + extraLength + commentLength
        }
    }

    private func bytes(at offset: UInt64, count: Int) throws -> [UInt8] {
        guard count >= 0, offset <= length, UInt64(count) <= length - offset else { throw KoboError("Output ZIP is invalid") }
        if count == 0 { return [] }
        try handle.seek(toOffset: offset)
        var data: [UInt8] = []
        data.reserveCapacity(count)
        while data.count < count {
            guard let part = try handle.read(upToCount: count - data.count), !part.isEmpty else { throw KoboError("Output ZIP is invalid") }
            data.append(contentsOf: part)
        }
        return data
    }

    private func u16(_ b: [UInt8], _ i: Int) -> UInt16 { UInt16(b[i]) | UInt16(b[i + 1]) << 8 }
    private func u32(_ b: [UInt8], _ i: Int) -> UInt32 { UInt32(u16(b, i)) | UInt32(u16(b, i + 2)) << 16 }
    private func u64(_ b: [UInt8], _ i: Int) -> UInt64 { UInt64(u32(b, i)) | UInt64(u32(b, i + 4)) << 32 }
}
