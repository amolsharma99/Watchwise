#!/usr/bin/env ruby
# frozen_string_literal: true

require "digest"
require "fileutils"
require "json"
require "open3"
require "optparse"
require "pathname"
require "tmpdir"

ROOT = File.expand_path("..", __dir__)
ALLOWLIST_PATH = File.join(ROOT, "store-package-files.txt")
FIXED_TIME = Time.utc(2020, 1, 1)

options = { output: nil, force: false }
OptionParser.new do |parser|
  parser.banner = "Usage: package_store.rb [--check] [--output PATH] [--force]"
  parser.on("--check", "Validate without creating a ZIP") { options[:output] = nil }
  parser.on("--output PATH", "Create the validated deterministic ZIP") { |path| options[:output] = File.expand_path(path) }
  parser.on("--force", "Replace an existing output ZIP") { options[:force] = true }
end.parse!

def fail!(message)
  warn "Store package validation failed: #{message}"
  exit 1
end

files = File.readlines(ALLOWLIST_PATH, chomp: true).map(&:strip).reject { |line| line.empty? || line.start_with?("#") }
fail!("allowlist is empty") if files.empty?
fail!("manifest.json must be the first entry") unless files.first == "manifest.json"
fail!("allowlist contains duplicates") unless files.uniq.length == files.length
files.each do |relative|
  path = Pathname.new(relative)
  fail!("unsafe path #{relative.inspect}") if path.absolute? || path.each_filename.include?("..")
  absolute = File.join(ROOT, relative)
  fail!("missing #{relative}") unless File.file?(absolute)
  fail!("symlink not allowed: #{relative}") if File.symlink?(absolute)
end

manifest = JSON.parse(File.read(File.join(ROOT, "manifest.json")))
fail!("Manifest V3 required") unless manifest["manifest_version"] == 3
fail!("minimum Chrome 116 required") unless manifest["minimum_chrome_version"] == "116"
fail!("unsafe extension CSP") unless manifest.dig("content_security_policy", "extension_pages") == "script-src 'self'; object-src 'self'"
expected_permissions = %w[alarms scripting sidePanel storage]
fail!("manifest permissions must be exactly #{expected_permissions.join(', ')}") unless manifest["permissions"] == expected_permissions
fail!("host permissions must be exactly https://*/*") unless manifest["host_permissions"] == ["https://*/*"]
fail!("incognito must be disabled") unless manifest["incognito"] == "not_allowed"

referenced = [manifest.dig("background", "service_worker"), manifest.dig("side_panel", "default_path"), manifest["options_page"]]
referenced.concat(Array(manifest["icons"]&.values), Array(manifest.dig("action", "default_icon")&.values))
Array(manifest["content_scripts"]).each { |entry| referenced.concat(Array(entry["js"]), Array(entry["css"])) }
missing = referenced.compact.uniq - files
fail!("manifest references excluded files: #{missing.join(', ')}") unless missing.empty?

files.grep(/\.js\z/).each do |relative|
  source = File.read(File.join(ROOT, relative))
  source.scan(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/m).flatten.each do |specifier|
    fail!("non-local module specifier #{specifier} in #{relative}") unless specifier.start_with?(".")
    resolved = File.expand_path(specifier, File.dirname(File.join(ROOT, relative))).delete_prefix("#{ROOT}/")
    fail!("#{relative} imports excluded module #{specifier}") unless files.include?(resolved)
  end
end

files.grep(/\.html\z/).each do |relative|
  File.read(File.join(ROOT, relative)).scan(/(?:src|href)=["']([^"']+)["']/i).flatten.each do |reference|
    next if reference.start_with?("#", "https://", "mailto:")
    local = reference.split(/[?#]/, 2).first
    next if local.empty?
    resolved = File.expand_path(local, File.dirname(File.join(ROOT, relative))).delete_prefix("#{ROOT}/")
    fail!("#{relative} references excluded file #{reference}") unless files.include?(resolved)
  end
end

secret_patterns = {
  "Google API key" => /AIza[0-9A-Za-z_-]{30,}/,
  "private key" => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  "bearer secret" => /Bearer\s+[0-9A-Za-z._-]{24,}/i
}
files.grep(/\.(?:js|json|html|css|txt)\z/).each do |relative|
  source = File.binread(File.join(ROOT, relative))
  secret_patterns.each { |label, pattern| fail!("#{label} in #{relative}") if source.match?(pattern) }
end

remote_code_patterns = {
  "remote script" => /<script\b[^>]*\bsrc=["']https?:\/\//i,
  "remote static import" => /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']https?:\/\//,
  "remote dynamic import" => /\bimport\s*\(\s*["']https?:\/\//,
  "remote importScripts" => /\bimportScripts\s*\([^)]*https?:\/\//,
  "eval" => /\beval\s*\(/,
  "Function constructor" => /\bnew\s+Function\s*\(/
}
files.grep(/\.(?:js|html)\z/).each do |relative|
  source = File.read(File.join(ROOT, relative))
  remote_code_patterns.each { |label, pattern| fail!("#{label} in #{relative}") if source.match?(pattern) }
end

expected_icons = { "assets/icon16.png" => 16, "assets/icon32.png" => 32, "assets/icon48.png" => 48, "assets/icon128.png" => 128 }
expected_icons.each do |relative, size|
  data = File.binread(File.join(ROOT, relative))
  fail!("invalid PNG signature: #{relative}") unless data.start_with?("\x89PNG\r\n\x1a\n".b)
  width, height, bit_depth, color_type = data.byteslice(16, 10).unpack("NNCC")
  fail!("wrong icon dimensions: #{relative}") unless width == size && height == size
  fail!("icon must be 8-bit RGBA: #{relative}") unless bit_depth == 8 && color_type == 6
end

if options[:output]
  output = options[:output]
  fail!("output must end in .zip") unless File.extname(output).downcase == ".zip"
  fail!("output exists; pass --force to replace") if File.exist?(output) && !options[:force]
  fail!("zip tools unavailable") unless File.executable?("/usr/bin/zip") && File.executable?("/usr/bin/unzip")
  Dir.mktmpdir("watchwise-store") do |staging|
    files.each do |relative|
      destination = File.join(staging, relative)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, relative), destination, preserve: false)
      File.chmod(0o644, destination)
      File.utime(FIXED_TIME, FIXED_TIME, destination)
    end
    FileUtils.mkdir_p(File.dirname(output))
    FileUtils.rm_f(output) if options[:force]
    _stdout, stderr, status = Open3.capture3({ "TZ" => "UTC" }, "/usr/bin/zip", "-X", "-q", output, *files, chdir: staging)
    fail!("zip failed: #{stderr}") unless status.success?
    listing, list_error, list_status = Open3.capture3("/usr/bin/unzip", "-Z1", output)
    fail!("cannot inspect ZIP: #{list_error}") unless list_status.success?
    fail!("ZIP differs from allowlist") unless listing.lines.map(&:chomp) == files
  end
  puts "Created #{output} (sha256 #{Digest::SHA256.file(output).hexdigest})"
else
  puts "Store package validation: PASS (#{files.length} files; no ZIP created)"
end
