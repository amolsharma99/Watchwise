#!/usr/bin/env swift
import Foundation

struct Manifest: Encodable {
    let name = "com.watchwise.bridge"
    let description = "Watchwise local playback event bridge"
    let path: String
    let type = "stdio"
    let allowed_origins: [String]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 3 else {
    fail("Usage: generate-native-host-manifest.swift <existing-manifest-directory> <absolute-WatchwiseBridge-path> <32-character-extension-id>")
}
let directory = URL(fileURLWithPath: arguments[0], isDirectory: true)
let bridge = URL(fileURLWithPath: arguments[1], isDirectory: false)
let extensionID = arguments[2]
guard directory.path.hasPrefix("/"), bridge.path.hasPrefix("/") else { fail("Directory and bridge path must be absolute.") }
var isDirectory: ObjCBool = false
guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
    fail("The explicitly selected manifest directory must already exist.")
}
guard FileManager.default.isExecutableFile(atPath: bridge.path) else { fail("WatchwiseBridge must exist and be executable.") }
let pattern = try! NSRegularExpression(pattern: "^[a-p]{32}$")
guard pattern.firstMatch(in: extensionID, range: NSRange(extensionID.startIndex..., in: extensionID)) != nil else {
    fail("Extension ID must contain exactly 32 lowercase characters from a through p.")
}
let manifest = Manifest(path: bridge.path, allowed_origins: ["chrome-extension://\(extensionID)/"])
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let destination = directory.appendingPathComponent("com.watchwise.bridge.json")
try encoder.encode(manifest).write(to: destination, options: [.atomic])
print("Wrote \(destination.path)")
