#!/usr/bin/env ruby
require "open3"
require "tmpdir"

root = File.expand_path("..", __dir__)
sources = %w[validation.js settings.js auto-analysis.js insights.js].map do |name|
  text = File.read(File.join(root, "lib", name))
  text.gsub(/^import .*?;\n/m, "").gsub(/\bexport\s+/, "")
end
test = File.read(File.join(__dir__, "counting_check.js"))

Dir.mktmpdir("watchwise-counting") do |directory|
  script = File.join(directory, "counting.js")
  File.write(script, (sources + [test]).join("\n"))
  output, error, status = Open3.capture3("/usr/bin/osascript", "-l", "JavaScript", script)
  abort [output, error].join("\n") unless status.success?
  combined = [output, error].join("\n")
  abort "Counting test did not report PASS" unless combined.include?("Dynamic intentional-start counting: PASS")
  puts "Dynamic intentional-start counting: PASS"
end
