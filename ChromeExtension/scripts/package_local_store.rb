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
MAPPING_PATH = File.join(ROOT, "store-local-package-files.txt")
FIXED_TIME = Time.utc(2020, 1, 1)
options = { output: nil, stage: nil, force: false }

OptionParser.new do |parser|
  parser.banner = "Usage: package_local_store.rb [--check] [--stage PATH] [--output PATH] [--force]"
  parser.on("--check", "Validate without retaining a staged tree or ZIP") {}
  parser.on("--stage PATH", "Write the validated production tree for inspection") { |path| options[:stage] = File.expand_path(path) }
  parser.on("--output PATH", "Create the deterministic Store ZIP") { |path| options[:output] = File.expand_path(path) }
  parser.on("--force", "Replace an existing stage/output") { options[:force] = true }
end.parse!

def fail!(message)
  warn "Local Store package validation failed: #{message}"
  exit 1
end

lines = File.readlines(MAPPING_PATH, chomp: true).map(&:strip).reject { |line| line.empty? || line.start_with?("#") }
mappings = lines.map { |line| line.split("|", 2) }
fail!("invalid mapping") if mappings.any? { |pair| pair.length != 2 || pair.any?(&:empty?) }
archive_files = mappings.map(&:last)
fail!("manifest.json must be first") unless archive_files.first == "manifest.json"
fail!("duplicate archive paths") unless archive_files.uniq.length == archive_files.length

mappings.each do |source, archive|
  [source, archive].each do |relative|
    path = Pathname.new(relative)
    fail!("unsafe path #{relative.inspect}") if path.absolute? || path.each_filename.include?("..")
  end
  absolute = File.join(ROOT, source)
  fail!("missing source #{source}") unless File.file?(absolute)
  fail!("symlink source forbidden: #{source}") if File.symlink?(absolute)
end

def stage_files(mappings, destination)
  mappings.each do |source, archive|
    target = File.join(destination, archive)
    FileUtils.mkdir_p(File.dirname(target))
    FileUtils.cp(File.join(ROOT, source), target, preserve: false)
    File.chmod(0o644, target)
    File.utime(FIXED_TIME, FIXED_TIME, target)
  end
end

def validate_stage!(stage, archive_files)
  manifest = JSON.parse(File.read(File.join(stage, "manifest.json")))
  fail!("Manifest V3 required") unless manifest["manifest_version"] == 3
  fail!("local Store version must be 0.4.3") unless manifest["version"] == "0.4.3"
  fail!("minimum Chrome 116 required") unless manifest["minimum_chrome_version"] == "116"
  fail!("permissions must be exactly scripting, sidePanel") unless manifest["permissions"] == %w[scripting sidePanel]
  fail!("host permission must be exactly https://*/*") unless manifest["host_permissions"] == ["https://*/*"]
  fail!("incognito must be disabled") unless manifest["incognito"] == "not_allowed"
  fail!("summary handoff script remains in manifest") if Array(manifest["content_scripts"]).any? { |entry| Array(entry["js"]).any? { |path| path.include?("studio") } }
  fail!("unsafe CSP") unless manifest.dig("content_security_policy", "extension_pages") == "script-src 'self'; object-src 'self'"

  referenced = [manifest.dig("background", "service_worker"), manifest.dig("side_panel", "default_path"), manifest["options_page"]]
  referenced.concat(Array(manifest["icons"]&.values), Array(manifest.dig("action", "default_icon")&.values))
  Array(manifest["content_scripts"]).each { |entry| referenced.concat(Array(entry["js"]), Array(entry["css"])) }
  missing = referenced.compact.uniq - archive_files
  fail!("manifest references excluded files: #{missing.join(', ')}") unless missing.empty?

  archive_files.grep(/\.html\z/).each do |relative|
    File.read(File.join(stage, relative)).scan(/(?:src|href)=["']([^"']+)["']/i).flatten.each do |reference|
      next if reference.start_with?("#", "https://", "mailto:")
      local = reference.split(/[?#]/, 2).first
      resolved = File.expand_path(local, File.dirname(File.join(stage, relative))).delete_prefix("#{stage}/")
      fail!("#{relative} references excluded file #{reference}") unless archive_files.include?(resolved)
    end
  end

  archive_files.grep(/\.js\z/).each do |relative|
    source = File.read(File.join(stage, relative))
    source.scan(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/m).flatten.each do |specifier|
      fail!("non-local module #{specifier} in #{relative}") unless specifier.start_with?(".")
      resolved = File.expand_path(specifier, File.dirname(File.join(stage, relative))).delete_prefix("#{stage}/")
      fail!("#{relative} imports excluded module #{specifier}") unless archive_files.include?(resolved)
    end
  end

  forbidden_paths = %w[content-seek.js studio-handoff.js studio-prefill.js lib/analysis.js lib/auto-analysis.js lib/gemini-protocol.js lib/index.js nano-pilot.html nano-pilot.js nano-pilot.css nano-sample.txt]
  forbidden_paths.each { |path| fail!("forbidden entry #{path}") if archive_files.include?(path) }
  forbidden_tokens = {
    "remote model provider" => /gemini|generativelanguage/i,
    "credential field" => /api.?key|apiKeyConfigured/i,
    "network call" => /\bfetch\s*\(/,
    "alternate network API" => /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|navigator\.sendBeacon/,
    "model feature setting" => /aiEnabled|autoAnalysisEnabled|ANALYZE_URL/,
    "model data store" => /analysis(?:Jobs|Results|Sources)/i,
    "model-facing copy" => /\banalys(?:is|e|ing|ed)\b|\bAI\b/i,
    "alarm API" => /chrome\.alarms|["']alarms["']/,
    "legacy storage API" => /chrome\.storage/,
    "seek capability" => /SEEK_PLAYER|SEEK_TIMESTAMP|suggestedTimestampSeconds|type:\s*["']seek["']/,
    "raw key export" => /exportKey\s*\(/
  }
  secret_patterns = { "Google credential" => /AIza[0-9A-Za-z_-]{30,}/, "private key" => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "bearer secret" => /Bearer\s+[0-9A-Za-z._-]{24,}/i }
  archive_files.grep(/\.(?:js|json|html|css|txt)\z/).each do |relative|
    source = File.read(File.join(stage, relative))
    forbidden_tokens.each do |label, pattern|
      fail!("#{label} in #{relative}") if source.match?(pattern)
    end
    secret_patterns.each { |label, pattern| fail!("#{label} in #{relative}") if source.match?(pattern) }
    fail!("remote executable code in #{relative}") if source.match?(/<script\b[^>]*\bsrc=["']https?:\/\//i) || source.match?(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']https?:\/\//) || source.match?(/\bimport\s*\(\s*["']https?:\/\//) || source.match?(/\bimportScripts\s*\([^)]*https?:\/\//) || source.match?(/\beval\s*\(/) || source.match?(/\bnew\s+Function\s*\(/)
  end

  background = File.read(File.join(stage, "background.js"))
  panel = File.read(File.join(stage, "sidepanel.html"))
  fail!("local tracking ingestion missing") unless background.include?("PLAYBACK_EVENT") && background.include?("repository.putEvent")
  fail!("local insight dashboard missing") unless background.include?("summarizeViewing") && panel.include?("Video breakdown")
  fail!("local interventions missing") unless background.include?("maybeGoalCheckIn") && background.include?("maybeNudge")
  fail!("privacy controls missing") unless %w[movieMode snooze quietEnabled exclusionForm exportData deleteData].all? { |id| panel.include?("id=\"#{id}\"") }
  fail!("public UI contains a third tab") unless panel.scan(/data-panel=/).length == 2
  css = File.read(File.join(stage, "sidepanel.css"))
  fail!("local tab layout is not two columns") unless css.include?("grid-template-columns:repeat(2,1fr)")
  fail!("dead result CSS leaked") if css.match?(/\.result|\.timeline|\.moment|\.timestamp|\.verdict|\.caveat/)

  { "assets/icon16.png" => 16, "assets/icon32.png" => 32, "assets/icon48.png" => 48, "assets/icon128.png" => 128 }.each do |relative, size|
    data = File.binread(File.join(stage, relative))
    fail!("invalid PNG #{relative}") unless data.start_with?("\x89PNG\r\n\x1a\n".b)
    width, height, depth, color = data.byteslice(16, 10).unpack("NNCC")
    fail!("bad icon #{relative}") unless width == size && height == size && depth == 8 && color == 6
  end
end

Dir.mktmpdir("watchwise-local-store") do |temporary|
  stage_files(mappings, temporary)
  validate_stage!(temporary, archive_files)

  if options[:stage]
    fail!("stage path already exists") if File.exist?(options[:stage])
    FileUtils.mkdir_p(File.dirname(options[:stage]))
    FileUtils.cp_r(temporary, options[:stage])
  end

  if options[:output]
    fail!("output must end in .zip") unless File.extname(options[:output]).downcase == ".zip"
    fail!("output exists; pass --force") if File.exist?(options[:output]) && !options[:force]
    FileUtils.mkdir_p(File.dirname(options[:output]))
    FileUtils.rm_f(options[:output]) if options[:force]
    _stdout, stderr, status = Open3.capture3({ "TZ" => "UTC" }, "/usr/bin/zip", "-X", "-q", options[:output], *archive_files, chdir: temporary)
    fail!("zip failed: #{stderr}") unless status.success?
    listing, list_error, list_status = Open3.capture3("/usr/bin/unzip", "-Z1", options[:output])
    fail!("cannot inspect ZIP: #{list_error}") unless list_status.success?
    fail!("ZIP differs from mapping") unless listing.lines.map(&:chomp) == archive_files
  end
end

if options[:output]
  puts "Created #{options[:output]} (sha256 #{Digest::SHA256.file(options[:output]).hexdigest})"
elsif options[:stage]
  puts "Created validated stage #{options[:stage]}"
else
  puts "Local Store package validation: PASS (#{archive_files.length} files; no ZIP created)"
end
