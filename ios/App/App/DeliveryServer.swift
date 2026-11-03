import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Read-only temporary delivery of a selected book or collection, compatible with the Kobo browser.
final class DeliveryServer {
    struct Entry {
        let file: URL
        let filename: String
        let mime: String
        let title: String
        let size: Int64
        let sha256: String?

        init(file: URL, filename: String, mime: String, title: String) {
            self.init(file: file, filename: filename, mime: mime, title: title, size: ExportPayload.fileLength(file), sha256: nil)
        }

        init(file: URL, filename: String, mime: String, title: String, size: Int64, sha256: String?) {
            self.file = file
            var safe = ""
            for scalar in filename.unicodeScalars {
                let allowed = (scalar >= "A" && scalar <= "Z") || (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9") || scalar == "." || scalar == "_" || scalar == "-"
                safe.unicodeScalars.append(allowed ? scalar : "_")
            }
            self.filename = safe
            self.mime = mime == "application/pdf" ? mime : "application/epub+zip"
            self.title = title
            self.size = size
            self.sha256 = sha256
        }
    }

    /// Thrown only when the requested port cannot be bound, so callers can fall back to another port.
    struct BindError: Error { let code: Int32 }

    let code: String
    let port: Int
    private let entries: [Entry]
    private let labels: [String: String]
    private let locale: String
    private let lock = NSLock()
    private var listener: Int32
    private var closed = false
    private var pending = 0
    private let workers: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "kobo-delivery-workers"
        queue.maxConcurrentOperationCount = 3
        return queue
    }()
    private static let maxPending = 3 + 12

    convenience init(file: URL, filename: String, mime: String, port: UInt16) throws {
        try self.init(entries: [Entry(file: file, filename: filename, mime: mime, title: filename)], locale: "en-GB", labels: [:], port: port)
    }

    init(entries: [Entry], locale: String, labels: [String: String], port: UInt16) throws {
        if entries.isEmpty { throw KoboError("No delivery files") }
        for entry in entries {
            if !ExportPayload.isFile(entry.file) || entry.size <= 0 || ExportPayload.fileLength(entry.file) != entry.size {
                throw KoboError("Delivery output is missing, empty or truncated")
            }
            if let hash = entry.sha256 { try ExportPayload.verifyFile(entry.file, expectedSize: entry.size, expectedHash: hash) }
        }
        self.entries = entries
        self.locale = locale.range(of: "^[a-zA-Z-]{2,16}$", options: .regularExpression) != nil ? locale : "en-GB"
        self.labels = labels
        self.code = String(format: "%06d", Int(UInt32.random(in: 0..<1_000_000)))

        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { throw KoboError("Could not open delivery socket") }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: INADDR_ANY)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        if bound != 0 { let error = errno; Darwin.close(fd); throw BindError(code: error) }
        if listen(fd, 50) != 0 { Darwin.close(fd); throw KoboError("Could not listen for deliveries") }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var actual = sockaddr_in()
        var actualLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &actualLength) } }
        self.port = Int(UInt16(bigEndian: actual.sin_port))
        self.listener = fd

        let acceptor = Thread { [weak self] in self?.acceptLoop() }
        acceptor.name = "kobo-delivery"
        acceptor.start()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 20 * 60) { [weak self] in self?.close() }
    }

    deinit { close() }

    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    func close() {
        lock.lock()
        if !closed { closed = true; Darwin.close(listener); listener = -1 }
        lock.unlock()
    }

    private func acceptLoop() {
        while true {
            lock.lock()
            if closed { lock.unlock(); return }
            let fd = listener
            lock.unlock()
            var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            _ = poll(&poller, 1, 250)
            lock.lock()
            if closed { lock.unlock(); return }
            let client = accept(fd, nil, nil)
            if client < 0 { lock.unlock(); continue }
            if pending >= Self.maxPending { lock.unlock(); Darwin.close(client); continue }
            pending += 1
            lock.unlock()
            // Accepted sockets inherit O_NONBLOCK on Darwin; requests use blocking I/O with timeouts.
            _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
            workers.addOperation { [weak self] in
                defer { Darwin.close(client); self?.finished() }
                // Work still queued when the session closes is dropped, like Java's shutdownNow().
                guard let self, !self.isClosed else { return }
                self.handle(client)
            }
        }
    }

    private func finished() { lock.lock(); pending -= 1; lock.unlock() }

    private static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;")
    }

    private func label(_ key: String, _ fallback: String) -> String { Self.escape(labels[key] ?? fallback) }

    private func route(_ index: Int) -> String { "/" + code + "/" + (entries.count > 1 ? "\(index)/" : "") + entries[index].filename }

    private func handle(_ socket: Int32) {
        var yes: Int32 = 1
        setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let out = SocketWriter(socket)

        var header: [UInt8] = []
        var tail: UInt32 = 0
        var byte: UInt8 = 0
        reading: while header.count < 8192 {
            let n = recv(socket, &byte, 1, 0)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            header.append(byte)
            tail = (tail << 8) | UInt32(byte)
            if tail == 0x0d0a0d0a { break reading }
        }
        let text = String(decoding: header.map { $0 < 0x80 ? $0 : 0x3F }, as: UTF8.self)
        let firstLine = text.components(separatedBy: "\r\n").first ?? ""
        var request = firstLine.components(separatedBy: " ")
        while let last = request.last, last.isEmpty { request.removeLast() } // Java String.split drops trailing empties.
        if request.isEmpty { request = [""] }
        guard request.count == 3, request[0] == "GET" || request[0] == "HEAD" else {
            page(out, "405 Method Not Allowed", label("methodNotAllowed", "Method not allowed."), head: false); return
        }
        let head = request[0] == "HEAD", path = request[1]
        if path.hasPrefix("/?code=") {
            let given = String(path.dropFirst(7)).components(separatedBy: "&").first ?? ""
            if given == code {
                out.write(Array("HTTP/1.1 303 See Other\r\nLocation: /\(code)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)); return
            }
            page(out, "404 Not Found", "<h1>" + label("wrongCode", "Invalid code") + "</h1><a href='/'>" + label("retry", "Try again") + "</a>", head: head); return
        }
        if path == "/" {
            page(out, "200 OK", "<h1>" + label("receiveTitle", "Receive books") + "</h1><p>" + label("enterCode", "Enter the code shown on your phone.") + "</p><form action='/' method='get'><input name='code' maxlength='6' size='8' autocomplete='off'/><button type='submit'>" + label("open", "Open") + "</button></form>", head: head)
            return
        }
        if path == "/" + code || path == "/" + code + "/" {
            var body = "<h1>" + label("readyKobo", "Ready for your Kobo") + "</h1><ol>"
            for index in entries.indices {
                body += "<li style='margin-bottom:24px'><a href='" + route(index) + "'>" + label("download", "Download") + ": " + Self.escape(entries[index].title) + "</a><br><small>" + Self.escape(entries[index].filename) + "</small></li>"
            }
            body += "</ol><p>" + label("closeBrowser", "After downloading, close the browser to find your books in the library.") + "</p>"
            page(out, "200 OK", body, head: head); return
        }
        guard let selected = entries.indices.first(where: { path == route($0) }).map({ entries[$0] }) else {
            page(out, "404 Not Found", label("notFound", "File not found."), head: head); return
        }
        if !ExportPayload.isFile(selected.file) || ExportPayload.fileLength(selected.file) != selected.size {
            page(out, "410 Gone", label("notFound", "File not found."), head: head); return
        }
        if let hash = selected.sha256 {
            do { try ExportPayload.verifyFile(selected.file, expectedSize: selected.size, expectedHash: hash) }
            catch { page(out, "410 Gone", label("notFound", "File not found."), head: head); return }
        }
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: \(selected.mime)\r\nContent-Length: \(selected.size)\r\nContent-Disposition: attachment; filename=\"\(selected.filename)\"\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        guard out.write(Array(headers.utf8)) else { return }
        if !head, let input = InputStream(url: selected.file) {
            input.open(); defer { input.close() }
            var buffer = [UInt8](repeating: 0, count: 32768)
            while true {
                let n = input.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                guard out.write(Array(buffer[0..<n])) else { break }
            }
        }
    }

    private func page(_ out: SocketWriter, _ status: String, _ body: String, head: Bool) {
        let data = Array(("<!doctype html><html lang='" + locale + "'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Kobo Book Manager</title></head><body style='font:22px sans-serif;color:#000;background:#fff;margin:24px'>" + body + "</body></html>").utf8)
        guard out.write(Array("HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(data.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)) else { return }
        if !head { out.write(data) }
    }

    /// iOS always gives the phone this address on its Personal Hotspot network.
    static func personalHotspotURL(port: Int) -> String { "http://172.20.10.1:\(port)" }

    /// Private IPv4 addresses of active, non-loopback interfaces (Wi-Fi and Personal Hotspot).
    static func localURLs(port: Int) -> [String] {
        var urls: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return urls }
        defer { freeifaddrs(list) }
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let item = pointer.pointee
            let flags = Int32(item.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, let address = item.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) else { continue }
            let ipv4 = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            let a = ipv4 >> 24, b = (ipv4 >> 16) & 0xFF
            guard a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) else { continue }
            let text = "\(a).\(b).\((ipv4 >> 8) & 0xFF).\(ipv4 & 0xFF)"
            let url = "http://\(text):\(port)"
            if !urls.contains(url) { urls.append(url) }
        }
        return urls
    }
}

/// Blocking writer that handles partial sends and reports a closed peer instead of raising SIGPIPE.
private struct SocketWriter {
    let socket: Int32
    init(_ socket: Int32) { self.socket = socket }

    @discardableResult
    func write(_ bytes: [UInt8]) -> Bool {
        var offset = 0
        while offset < bytes.count {
            let n = bytes.withUnsafeBytes { send(socket, $0.baseAddress! + offset, bytes.count - offset, 0) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return false }
            offset += n
        }
        return true
    }
}
