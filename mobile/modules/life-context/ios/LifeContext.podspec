require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json'))) rescue {}

Pod::Spec.new do |s|
  s.name           = 'LifeContext'
  s.version        = package['version'] || '0.1.0'
  s.summary        = 'Privacy-first life context module for J AI'
  s.description    = 'Unsupported iOS stub for the J AI life context Expo module.'
  s.author         = 'J AI'
  s.homepage       = 'https://example.com'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
