require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'PiMobileNativePush'
  s.module_name = 'PiNativePush'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'MIT' }
  s.homepage = 'https://github.com/xing-shuyin/pi-web-ui'
  s.author = 'pi-web-ui contributors'
  s.source = { :git => 'https://github.com/xing-shuyin/pi-web-ui.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.swift_version = '5.9'
  s.static_framework = true
  s.frameworks = 'Security', 'UserNotifications'
  s.dependency 'Capacitor', '~> 8.6'
  s.dependency 'JPush', '6.3.0'
  s.dependency 'JCore', '5.6.0'
end
