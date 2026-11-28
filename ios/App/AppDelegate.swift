import UIKit
import AVFoundation

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 训练音乐与提示音:静音键打开时也能出声,并可与摄像头同时使用
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        UIApplication.shared.isIdleTimerDisabled = true   // 训练中不自动锁屏

        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = WebViewController()
        w.backgroundColor = UIColor(red: 0.04, green: 0.06, blue: 0.09, alpha: 1)
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
