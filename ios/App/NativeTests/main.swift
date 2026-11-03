import Foundation
import CryptoKit
#if canImport(Darwin)
import Darwin
#endif

// Ports of android/app/src/test (JUnit) plus iOS-specific cases, run against the app's
// platform-independent Swift sources. Run with: scripts/test-ios-native.sh

var failures = 0, passed = 0
func check(_ condition: @autoclosure () throws -> Bool, _ message: String, file: StaticString = #file, line: UInt = #line) {
    do { if try condition() { return } } catch { print("  error: \(error)") }
    failures += 1; print("FAIL \(line): \(message)")
}
func throwsError(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
func test(_ name: String, _ body: () throws -> Void) {
    let before = failures
    do { try body() } catch { failures += 1; print("FAIL \(name): unexpected \(error)") }
    if failures == before { passed += 1; print("ok   \(name)") } else { print("     in \(name)") }
}
func hash(_ bytes: [UInt8]) -> String { ExportPayload.hex(SHA256.hash(data: bytes)) }
func temp(_ name: String = UUID().uuidString) -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("kobo-native-tests").appendingPathComponent(name)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

// MARK: - Minimal ZIP writer for fixtures (stored or raw-deflate entries).
func crc32(_ bytes: [UInt8]) -> UInt32 {
    var crc: UInt32 = 0xFFFF_FFFF
    for byte in bytes { crc ^= UInt32(byte); for _ in 0..<8 { crc = (crc >> 1) ^ (0xEDB8_8320 & (0 &- (crc & 1))) } }
    return ~crc
}
func zip(_ files: [(String, [UInt8], Bool)]) -> [UInt8] {
    func le16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
    func le32(_ v: UInt32) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8(v >> 24)] }
    var out: [UInt8] = [], central: [UInt8] = []
    for (name, data, deflate) in files {
        let payload = deflate ? [UInt8](try! (Data(data) as NSData).compressed(using: .zlib) as Data) : data
        let method = deflate ? 8 : 0, crc = crc32(data), offset = UInt32(out.count), n = Array(name.utf8)
        out += le32(0x04034b50) + le16(20) + le16(0) + le16(method) + le16(0) + le16(0) + le32(crc) + le32(UInt32(payload.count)) + le32(UInt32(data.count)) + le16(n.count) + le16(0) + n + payload
        central += le32(0x02014b50) + le16(20) + le16(20) + le16(0) + le16(method) + le16(0) + le16(0) + le32(crc) + le32(UInt32(payload.count)) + le32(UInt32(data.count)) + le16(n.count) + le16(0) + le16(0) + le16(0) + le16(0) + le32(0) + le32(offset) + n
    }
    let start = UInt32(out.count)
    out += central + le32(0x06054b50) + le16(0) + le16(0) + le16(files.count) + le16(files.count) + le32(UInt32(central.count)) + le32(start) + le16(0)
    return out
}
let container = Array("<container xmlns='urn:oasis:names:tc:opendocument:xmlns:container' version='1.0'><rootfiles><rootfile full-path='book.opf' media-type='application/oebps-package+xml'/></rootfiles></container>".utf8)
func epub(deflated: Bool = true) -> [UInt8] {
    zip([("mimetype", Array("application/epub+zip".utf8), false), ("META-INF/container.xml", container, deflated),
         ("book.opf", Array("<package xmlns='http://www.idpf.org/2007/opf' version='3.0' unique-identifier='uid'><metadata/><manifest/><spine/></package>".utf8), deflated),
         ("page.xhtml", Array("<html xmlns='http://www.w3.org/1999/xhtml'><body><p>Converted book</p></body></html>".utf8), deflated)])
}
func pdf() -> [UInt8] { Array("%PDF-1.7\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Count 0/Kids[]>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n".utf8) }
@discardableResult func stage(_ root: URL, _ bytes: [UInt8]) throws -> URL {
    let file = root.appendingPathComponent("delivery/session/export")
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(bytes).write(to: file); return file
}

// MARK: - HTTP client
func request(_ port: Int, _ raw: String, readTimeout: Int = 3) -> [UInt8] {
    let fd = socket(AF_INET, SOCK_STREAM, 0); defer { close(fd) }
    var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_port = UInt16(port).bigEndian; address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var timeout = timeval(tv_sec: readTimeout, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    guard withUnsafePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }) == 0 else { return [] }
    let bytes = Array(raw.utf8); _ = bytes.withUnsafeBytes { send(fd, $0.baseAddress, bytes.count, 0) }
    var result: [UInt8] = [], buffer = [UInt8](repeating: 0, count: 65536)
    while true { let n = recv(fd, &buffer, buffer.count, 0); if n <= 0 { break }; result += buffer[0..<n] }
    return result
}
func get(_ server: DeliveryServer, _ path: String) -> [UInt8] { request(server.port, "GET \(path) HTTP/1.1\r\nHost: localhost\r\n\r\n") }
func text(_ bytes: [UInt8]) -> String { String(decoding: bytes, as: UTF8.self) }
func body(_ bytes: [UInt8]) -> [UInt8] {
    for i in 0..<max(0, bytes.count - 3) where bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10 { return Array(bytes[(i + 4)...]) }
    return []
}

// MARK: - BookContentTest
test("BookContent recognises book signatures without names or MIME types") {
    check(BookContent.candidate(InputStream(data: Data([0x50, 0x4B, 3, 4, 20]))), "zip")
    check(BookContent.candidate(InputStream(data: Data("%PDF-1.7".utf8))), "pdf")
}
test("BookContent ignores unrelated and truncated files") {
    check(!BookContent.candidate(nil), "nil")
    for value in ["", "PK", "%PDF", "image.png", "text %PDF-1.7"] { check(!BookContent.candidate(InputStream(data: Data(value.utf8))), value) }
}
test("BookContent reads only the header from files") {
    let dir = temp(), file = dir.appendingPathComponent("noext")
    try Data("%PDF-1.7 rest".utf8).write(to: file); check(BookContent.candidate(file: file), "pdf file")
    try Data([0x50, 0x4B, 3]).write(to: file); check(!BookContent.candidate(file: file), "truncated zip")
}

// MARK: - UpdatePolicyTest
let page = "https://github.com/Yujilik/KoboBookManager/releases/tag/0.2.6"
test("UpdatePolicy accepts both stable release tag conventions") {
    _ = try UpdatePolicy.release(page); _ = try UpdatePolicy.release(page.replacingOccurrences(of: "/0.2.6", with: "/v0.2.6"))
}
test("UpdatePolicy rejects external and non-release destinations") {
    for bad in [page.replacingOccurrences(of: "https:", with: "http:"), page.replacingOccurrences(of: "Yujilik", with: "someone"),
                page.replacingOccurrences(of: "github.com/", with: "github.com.evil.example/"),
                page.replacingOccurrences(of: "github.com/", with: "user:password@github.com/"),
                page.replacingOccurrences(of: "github.com/", with: "github.com:8443/"), page + "?redirect=other",
                page + "#fragment", page + "-beta", page.replacingOccurrences(of: "/tag/", with: "/download/"),
                page.replacingOccurrences(of: "/0.2.6", with: "/../0.2.6"), page.replacingOccurrences(of: "/0.2.6", with: "/0.02.6"),
                page + "?", page + "#", "https://GitHub.com/Yujilik/KoboBookManager/releases/tag/0.2.6", "not a url"] {
        check(throwsError { _ = try UpdatePolicy.release(bad) }, bad)
    }
}

// MARK: - ExportPayloadTest
test("ExportPayload validates a converted EPUB and keeps the exact staged bytes") {
    for deflated in [true, false] {
        let root = temp(), bytes = epub(deflated: deflated)
        let file = try stage(root, bytes)
        let checked = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.kepub.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes))
        check(checked.file == ExportPayload.canonical(file), "canonical file"); check(checked.size == Int64(bytes.count), "size"); check(checked.sha256 == hash(bytes), "hash")
        let output = OutputStream.toMemory(); output.open()
        try ExportPayload.copy(InputStream(url: checked.file), output, expectedSize: checked.size, expectedHash: checked.sha256)
        let saved = output.property(forKey: .dataWrittenToMemoryStreamKey) as! Data
        check([UInt8](saved) == bytes, "copied bytes")
        try ExportPayload.verifyStream(InputStream(data: saved), expectedSize: checked.size, expectedHash: checked.sha256)
    }
}
test("ExportPayload rejects zero-length, truncated, wrong-hash and missing files") {
    let root = temp(), bytes = epub()
    let file = try stage(root, [])
    let v = { (path: String, size: Int, h: String?) in _ = try ExportPayload.validate(cacheDirectory: root, path: path, name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(size), expectedHash: h) }
    check(throwsError { try v("delivery/session/export", 0, hash([])) }, "zero")
    check(throwsError { try v("delivery/session/export", bytes.count, hash(bytes)) }, "truncated")
    try Data(bytes).write(to: file)
    check(throwsError { try v("delivery/session/export", bytes.count, String(repeating: "0", count: 64)) }, "wrong hash")
    check(throwsError { try v("delivery/session/export", bytes.count, nil) }, "nil hash")
    check(throwsError { try v("delivery/missing", bytes.count, hash(bytes)) }, "missing")
    check(throwsError { try v("delivery/session", bytes.count, hash(bytes)) }, "directory")
}
test("ExportPayload cannot substitute the original PDF for a requested converted EPUB") {
    let root = temp(), bytes = pdf(); try stage(root, bytes)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "pdf as epub")
    _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.pdf", mime: "application/pdf", expectedSize: Int64(bytes.count), expectedHash: hash(bytes))
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.epub", mime: "application/pdf", expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "pdf named epub")
    let converted = epub(); try stage(root, converted)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.pdf", mime: "application/pdf", expectedSize: Int64(converted.count), expectedHash: hash(converted)) }, "epub as pdf")
}
test("ExportPayload rejects a plain ZIP disguised as EPUB but allows an archive export") {
    let root = temp(), bytes = zip([("backup.json", Array("{}".utf8), true)]); try stage(root, bytes)
    _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "backup.zip", mime: "application/zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes))
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "zip as epub")
    let empty = zip([("folder/", [], false)]); try stage(root, empty)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "backup.zip", mime: "application/zip", expectedSize: Int64(empty.count), expectedHash: hash(empty)) }, "empty zip")
    let wrongType = zip([("mimetype", Array("application/epub+zipX".utf8), false), ("META-INF/container.xml", container, true)]); try stage(root, wrongType)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(wrongType.count), expectedHash: hash(wrongType)) }, "bad mimetype")
    let garbage: [UInt8] = Array("PK\u{3}\u{4} definitely not a zip".utf8); try stage(root, garbage)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "backup.zip", mime: "application/zip", expectedSize: Int64(garbage.count), expectedHash: hash(garbage)) }, "garbage zip")
}
test("ExportPayload staged paths cannot escape the app cache") {
    let root = temp(), bytes = epub(); let file = try stage(root, bytes)
    let outside = root.deletingLastPathComponent().appendingPathComponent("outside-\(UUID().uuidString)"); try Data(bytes).write(to: outside)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "../" + outside.lastPathComponent, name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "dotdot")
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: file.path, name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "absolute")
    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link"), withDestinationURL: outside)
    check(throwsError { _ = try ExportPayload.validate(cacheDirectory: root, path: "link", name: "book.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "symlink")
}
test("ExportPayload readback catches providers that silently truncate the output") {
    let bytes = epub()
    check(throwsError { try ExportPayload.verifyStream(InputStream(data: Data(bytes.prefix(8))), expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "truncated readback")
    let sink = OutputStream.toMemory()
    check(throwsError { try ExportPayload.copy(InputStream(data: Data(bytes.prefix(5))), sink, expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "short copy")
    check(throwsError { try ExportPayload.verifyStream(InputStream(data: Data(bytes + [0])), expectedSize: Int64(bytes.count), expectedHash: hash(bytes)) }, "long readback")
}
test("ExportPayload validates a ZIP produced by the system zip tool") {
    let dir = temp(), src = dir.appendingPathComponent("src")
    try FileManager.default.createDirectory(at: src.appendingPathComponent("META-INF"), withIntermediateDirectories: true)
    try Data("application/epub+zip".utf8).write(to: src.appendingPathComponent("mimetype"))
    try Data(container).write(to: src.appendingPathComponent("META-INF/container.xml"))
    try Data(repeating: 65, count: 300_000).write(to: src.appendingPathComponent("big.xhtml"))
    let task = Process(); task.currentDirectoryURL = src; task.executableURL = URL(fileURLWithPath: "/bin/sh")
    task.arguments = ["-c", "/usr/bin/zip -q -X -0 ../out.epub mimetype && /usr/bin/zip -q -X -r -9 ../out.epub META-INF big.xhtml"]
    try task.run(); task.waitUntilExit()
    let bytes = [UInt8](try Data(contentsOf: dir.appendingPathComponent("out.epub")))
    let root = temp(); try stage(root, bytes)
    _ = try ExportPayload.validate(cacheDirectory: root, path: "delivery/session/export", name: "x.epub", mime: "application/epub+zip", expectedSize: Int64(bytes.count), expectedHash: hash(bytes))
}

// MARK: - DeliveryServerTest
test("DeliveryServer delivers the entire collection as separate books and localises the page") {
    let dir = temp(), first = dir.appendingPathComponent("one.epub"), second = dir.appendingPathComponent("two.epub")
    try Data([1, 2, 3]).write(to: first); try Data([4, 5, 6]).write(to: second)
    let server = try DeliveryServer(entries: [.init(file: first, filename: "same.kepub.epub", mime: "application/epub+zip", title: "Volume <one>"),
                                              .init(file: second, filename: "same.kepub.epub", mime: "application/epub+zip", title: "Volume two")],
                                    locale: "ja", labels: ["receiveTitle": "本を受け取る", "download": "ダウンロード"], port: 0)
    defer { server.close() }
    check(text(get(server, "/")).contains("本を受け取る"), "localised root")
    let page = text(get(server, "/" + server.code))
    check(page.contains("lang='ja'"), "lang"); check(page.contains("ダウンロード"), "download label")
    check(page.contains("Volume &lt;one&gt;"), "escaped"); check(!page.contains("Volume <one>"), "not raw")
    for i in 0..<2 { check(body(get(server, "/\(server.code)/\(i)/same.kepub.epub")) == (i == 0 ? [1, 2, 3] : [4, 5, 6]), "book \(i)") }
    check(text(get(server, "/\(server.code)/2/same.kepub.epub")).contains("404 Not Found"), "out of range")
}
test("DeliveryServer downloads only the selected book with correct bytes and extension") {
    let file = temp().appendingPathComponent("kobo-test.epub"); let payload: [UInt8] = [80, 75, 3, 4, 0, 255, 13, 10]
    try Data(payload).write(to: file)
    let server = try DeliveryServer(file: file, filename: "book.kepub.epub", mime: "application/epub+zip", port: 0); defer { server.close() }
    let root = text(get(server, "/")); check(root.contains("200 OK"), "root 200"); check(root.contains("name='code'"), "code form")
    check(text(get(server, "/wrong/book.kepub.epub")).contains("404 Not Found"), "wrong code")
    let page = text(get(server, "/" + server.code))
    check(page.contains("/\(server.code)/book.kepub.epub"), "link"); check(page.contains("<small>book.kepub.epub</small>"), "small")
    let download = get(server, "/\(server.code)/book.kepub.epub"), raw = String(decoding: download, as: UTF8.self)
    check(raw.contains("Content-Type: application/epub+zip"), "mime"); check(raw.contains("filename=\"book.kepub.epub\""), "filename")
    check(raw.contains("Content-Length: 8\r\n"), "length"); check(body(download) == payload, "bytes")
    check(text(get(server, "/\(server.code)/../secret")).contains("404 Not Found"), "traversal")
}
test("DeliveryServer refuses empty files and stops serving truncated or changed payloads") {
    let file = temp().appendingPathComponent("kobo-empty.epub"); try Data().write(to: file)
    check(throwsError { _ = try DeliveryServer(file: file, filename: "book.epub", mime: "application/epub+zip", port: 0) }, "empty")
    let payload: [UInt8] = [80, 75, 3, 4, 1, 2, 3, 4]; try Data(payload).write(to: file)
    let server = try DeliveryServer(entries: [.init(file: file, filename: "book.epub", mime: "application/epub+zip", title: "Book", size: Int64(payload.count), sha256: hash(payload))], locale: "en-GB", labels: [:], port: 0)
    defer { server.close() }
    check(body(get(server, "/\(server.code)/book.epub")) == payload, "served")
    try Data([80, 75, 3, 4, 9, 9, 9, 9]).write(to: file); check(text(get(server, "/\(server.code)/book.epub")).contains("410 Gone"), "changed")
    try Data().write(to: file); check(text(get(server, "/\(server.code)/book.epub")).contains("410 Gone"), "emptied")
}
test("DeliveryServer code form, HEAD, methods, sanitised names and PDFs") {
    let file = temp().appendingPathComponent("b.pdf"); try Data(pdf()).write(to: file)
    let server = try DeliveryServer(entries: [.init(file: file, filename: "Ünïcode name?.pdf", mime: "application/pdf", title: "T")], locale: "<bad>", labels: ["wrongCode": "Código <inválido>"], port: 0)
    defer { server.close() }
    let redirect = text(get(server, "/?code=\(server.code)&x=1"))
    check(redirect.hasPrefix("HTTP/1.1 303 See Other\r\nLocation: /\(server.code)\r\n"), "redirect")
    let wrong = text(get(server, "/?code=000000x")); check(wrong.contains("404 Not Found") && wrong.contains("Código &lt;inválido&gt;"), "wrong code page")
    check(text(get(server, "/")).contains("lang='en-GB'"), "locale fallback")
    let link = "/\(server.code)/_n_code_name_.pdf"
    check(text(get(server, "/" + server.code)).contains(link), "sanitised filename")
    let head = request(server.port, "HEAD \(link) HTTP/1.1\r\n\r\n")
    check(text(head).contains("Content-Type: application/pdf") && body(head).isEmpty, "HEAD no body")
    check(text(request(server.port, "POST / HTTP/1.1\r\n\r\n")).contains("405 Method Not Allowed"), "POST")
    check(text(request(server.port, "GET  / HTTP/1.1\r\n\r\n")).contains("405"), "malformed")
    check(text(request(server.port, "GET / HTTP/1.1  \r\n\r\n")).contains("200 OK"), "trailing spaces like Java split")
}
test("DeliveryServer falls back when 8080 is busy and frees its port on close") {
    let file = temp().appendingPathComponent("p.epub"); try Data([1]).write(to: file)
    let first = try DeliveryServer(file: file, filename: "a.epub", mime: "application/epub+zip", port: 0)
    let port = UInt16(first.port)
    var bindFailed = false
    do { _ = try DeliveryServer(file: file, filename: "a.epub", mime: "application/epub+zip", port: port) } catch is DeliveryServer.BindError { bindFailed = true }
    check(bindFailed, "BindError on busy port")
    first.close(); check(first.isClosed, "closed")
    let again = try DeliveryServer(file: file, filename: "a.epub", mime: "application/epub+zip", port: port)
    check(again.port == Int(port), "port reusable immediately after close"); again.close()
    check(request(Int(port), "GET / HTTP/1.1\r\n\r\n").isEmpty, "no longer serving")
}
test("DeliveryServer survives clients that disconnect mid-download and slow/idle clients") {
    let file = temp().appendingPathComponent("big.epub"); try Data(repeating: 7, count: 8 * 1024 * 1024).write(to: file)
    let server = try DeliveryServer(file: file, filename: "big.epub", mime: "application/epub+zip", port: 0); defer { server.close() }
    for _ in 0..<5 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var a = sockaddr_in(); a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); a.sin_family = sa_family_t(AF_INET); a.sin_port = UInt16(server.port).bigEndian; a.sin_addr.s_addr = inet_addr("127.0.0.1")
        _ = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        let r = Array("GET /\(server.code)/big.epub HTTP/1.1\r\n\r\n".utf8); _ = r.withUnsafeBytes { send(fd, $0.baseAddress, r.count, 0) }
        var buf = [UInt8](repeating: 0, count: 1024); _ = recv(fd, &buf, buf.count, 0)
        var linger = linger(l_onoff: 1, l_linger: 0); setsockopt(fd, SOL_SOCKET, SO_LINGER, &linger, socklen_t(MemoryLayout<linger>.size))
        close(fd)
    }
    // Idle connections must not wedge the 3 workers forever (5 s read timeout).
    var idle: [Int32] = []
    for _ in 0..<3 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var a = sockaddr_in(); a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); a.sin_family = sa_family_t(AF_INET); a.sin_port = UInt16(server.port).bigEndian; a.sin_addr.s_addr = inet_addr("127.0.0.1")
        _ = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        idle.append(fd)
    }
    let started = Date()
    let full = request(server.port, "GET /\(server.code)/big.epub HTTP/1.1\r\n\r\n", readTimeout: 12)
    check(body(full).count == 8 * 1024 * 1024, "full download after idle clients time out")
    check(Date().timeIntervalSince(started) < 9, "read timeout releases workers")
    idle.forEach { close($0) }
}
test("DeliveryServer.localURLs lists only private IPv4 addresses") {
    for url in DeliveryServer.localURLs(port: 8080) {
        check(url.hasPrefix("http://10.") || url.hasPrefix("http://192.168.") || url.range(of: "^http://172\\.(1[6-9]|2[0-9]|3[01])\\.", options: .regularExpression) != nil, url)
        check(url.hasSuffix(":8080"), url)
    }
    print("     local URLs here: \(DeliveryServer.localURLs(port: 8080))")
}

// MARK: - FolderAccess
test("FolderAccess scans, reads and keeps stable URIs") {
    let suite = "kobo-tests-\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
    let access = FolderAccess(defaults: defaults), root = temp().appendingPathComponent("Books")
    let nested = root.appendingPathComponent("Série #1/100% sub")
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
    try Data(epub()).write(to: root.appendingPathComponent("a.epub"))
    try Data(pdf()).write(to: nested.appendingPathComponent("Ünï côde?.PDF"))
    try Data([0x50, 0x4B, 3, 4, 1]).write(to: nested.appendingPathComponent("noextension"))
    try Data([0x89, 0x50, 0x4E, 0x47]).write(to: root.appendingPathComponent("image.png"))
    let folder = try access.register(root)
    check(folder.uri.hasPrefix("ios-folder:"), "uri"); check(folder.name == "Books", "name \(folder.name)")
    check(try access.register(root).uri == folder.uri, "same folder keeps its URI")
    let files = try access.scan(folder.uri)
    check(Set(files.map(\.name)) == ["a.epub", "Ünï côde?.PDF", "noextension"], "names \(files.map(\.name))")
    for file in files {
        let data = try access.read(file.uri)
        check(Int64(data.count) == file.size, "size of \(file.name)")
        check(file.modified != "0" && Int64(file.modified)! > 1_600_000_000_000, "modified ms")
    }
    check(try access.read(files.first { $0.name == "a.epub" }!.uri) == Data(epub()), "bytes")
    check(throwsError { _ = try access.read(folder.uri + "/../secret") }, "traversal")
    check(throwsError { _ = try access.read(folder.uri + "/a.epub", limit: 10) }, "size limit")
    check(throwsError { _ = try access.scan("ios-folder:unknown") }, "unknown folder")
    check(throwsError { _ = try access.scan("content://x") }, "foreign uri")
}
test("FolderAccess rejects folders nested deeper than Android's limit") {
    let suite = "kobo-tests-\(UUID().uuidString)", defaults = UserDefaults(suiteName: suite)!; defer { defaults.removePersistentDomain(forName: suite) }
    let access = FolderAccess(defaults: defaults), root = temp().appendingPathComponent("Deep")
    var deep = root; for i in 0..<14 { deep.appendPathComponent("d\(i)") }
    try FileManager.default.createDirectory(at: deep, withIntermediateDirectories: true)
    check(throwsError { _ = try access.scan(try access.register(root).uri) }, "too deep")
}

try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("kobo-native-tests"))
print("\n\(passed) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
