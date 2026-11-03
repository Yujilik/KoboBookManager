import Foundation

/// Fast folder prefilter. The web importer validates each EPUB's internal structure.
enum BookContent {
    /// Reads at most five bytes, then checks for a ZIP (EPUB) or PDF signature.
    static func candidate(_ input: InputStream?) -> Bool {
        guard let input else { return false }
        if input.streamStatus == .notOpen { input.open() }
        var header = [UInt8](repeating: 0, count: 5)
        var length = 0
        while length < header.count {
            let count = header.withUnsafeMutableBufferPointer { buffer in
                input.read(buffer.baseAddress! + length, maxLength: buffer.count - length)
            }
            if count <= 0 { break }
            length += count
        }
        return candidate(header: Array(header.prefix(length)))
    }

    static func candidate(header: [UInt8]) -> Bool {
        (header.count >= 4 && header[0] == 0x50 && header[1] == 0x4B && header[2] == 3 && header[3] == 4) ||
            (header.count >= 5 && header[0] == 0x25 && header[1] == 0x50 && header[2] == 0x44 && header[3] == 0x46 && header[4] == 0x2D)
    }

    static func candidate(file: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? handle.close() }
        var header: [UInt8] = []
        while header.count < 5 {
            guard let chunk = try? handle.read(upToCount: 5 - header.count), !chunk.isEmpty else { break }
            header.append(contentsOf: chunk)
        }
        return candidate(header: header)
    }
}
