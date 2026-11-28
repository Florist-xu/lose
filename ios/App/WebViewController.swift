import UIKit
import WebKit

/// App 只是一个"壳":界面和功能全部从你的服务器在线加载。
/// 服务器上 git pull 更新代码后,App 重新打开即是最新版本,无需重装。
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private let defaultsKey = "serverURL"
    private let suggested = "https://192.168.1.71:6061"
    private var serverURL: URL? {
        get { UserDefaults.standard.string(forKey: defaultsKey).flatMap(URL.init(string:)) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: defaultsKey) }
    }
    private let statusLabel = UILabel()
    private let bg = UIColor(red: 0.04, green: 0.06, blue: 0.09, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = bg

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []        // 休息音乐/示范音频可自动播放
        config.applicationNameForUserAgent = "GenLianApp/1.0"
        config.userContentController.add(self, name: "app")         // 网页里可调用 window.webkit.messageHandlers.app

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
        webView.scrollView.contentInsetAdjustmentBehavior = .never   // 由网页用 safe-area 自行避让刘海
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false                           // 长按链接不弹预览
        webView.scrollView.minimumZoomScale = 1                    // 禁止双指缩放,像原生 App 一样
        webView.scrollView.maximumZoomScale = 1
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        view.addSubview(webView)

        statusLabel.textColor = UIColor(white: 1, alpha: 0.6)
        statusLabel.font = .systemFont(ofSize: 15)
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
        ])

        // 双指长按 1 秒:修改服务器地址(地址变了也能自救)
        let lp = UILongPressGestureRecognizer(target: self, action: #selector(askServer))
        lp.numberOfTouchesRequired = 2
        lp.minimumPressDuration = 1
        view.addGestureRecognizer(lp)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if webView.url == nil { if serverURL == nil { askServer() } else { load() } }
    }

    private func load() {
        guard let url = serverURL else { return askServer() }
        statusLabel.text = "正在连接\n\(url.absoluteString)"
        webView.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15))
    }

    @objc private func askServer() {
        if presentedViewController != nil { return }
        let a = UIAlertController(title: "服务器地址",
                                  message: "填写电脑/Termux 上跟练服务的地址(需与手机在同一网络)。\n例如 https://192.168.1.71:6061\n之后可用双指长按屏幕 1 秒修改。",
                                  preferredStyle: .alert)
        a.addTextField { tf in
            tf.text = self.serverURL?.absoluteString ?? self.suggested
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
            tf.clearButtonMode = .whileEditing
        }
        a.addAction(UIAlertAction(title: "连接", style: .default) { _ in
            var s = (a.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty, !s.contains("://") { s = "https://" + s }
            if let u = URL(string: s), u.host != nil { self.serverURL = u; self.load() } else { self.askServer() }
        })
        if serverURL != nil { a.addAction(UIAlertAction(title: "取消", style: .cancel)) }
        present(a, animated: true)
    }

    // MARK: 自签名证书:只信任你填写的这台服务器
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           challenge.protectionSpace.host == serverURL?.host,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        statusLabel.text = nil
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showError(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showError(error) }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    private func showError(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled { return }
        statusLabel.text = "连接失败"
        let a = UIAlertController(title: "连不上服务器",
                                  message: "\(serverURL?.absoluteString ?? "")\n\(e.localizedDescription)\n\n请确认服务已启动(sh start.sh),且手机和服务器在同一 Wi-Fi。",
                                  preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "重试", style: .default) { _ in self.load() })
        a.addAction(UIAlertAction(title: "修改地址", style: .default) { _ in self.askServer() })
        if presentedViewController == nil { present(a, animated: true) }
    }

    // MARK: 摄像头权限:网页申请时直接放行(系统仍会先弹一次授权)
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: 网页里的 alert / confirm / prompt(WKWebView 默认不显示,需要原生实现)
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        presentSafely(a) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "确定", style: .destructive) { _ in completionHandler(true) })
        presentSafely(a) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        presentSafely(a) { completionHandler(nil) }
    }

    private func presentSafely(_ a: UIAlertController, fallback: () -> Void) {
        if presentedViewController == nil { present(a, animated: true) } else { fallback() }
    }

    // MARK: 网页 -> App:目前只支持"修改服务器地址"
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as? String) == "server" { askServer() }
    }
}
