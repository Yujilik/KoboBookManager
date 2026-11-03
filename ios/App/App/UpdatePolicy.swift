import Foundation

/// Only this project's public release pages may be opened by the update button.
enum UpdatePolicy {
    private static let pathPattern = try! NSRegularExpression(
        pattern: "^/Yujilik/KoboBookManager/releases/tag/v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")

    static func release(_ address: String) throws -> URL {
        guard let parts = URLComponents(string: address), let url = parts.url,
              parts.scheme == "https", parts.percentEncodedHost == "github.com",
              parts.port == nil || parts.port == 443,
              parts.percentEncodedUser == nil, parts.percentEncodedPassword == nil,
              parts.percentEncodedQuery == nil, parts.percentEncodedFragment == nil
        else { throw KoboError("Invalid release URL") }
        let path = parts.percentEncodedPath
        guard pathPattern.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
        else { throw KoboError("Invalid release URL") }
        return url
    }
}
