import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OpenSafari Bridge Fixture',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blueGrey),
      ),
      home: const BridgePage(),
    );
  }
}

class BridgePage extends StatefulWidget {
  const BridgePage({super.key});

  @override
  State<BridgePage> createState() => _BridgePageState();
}

class _BridgePageState extends State<BridgePage> {
  bool _webViewVisible = false;
  String _nativeStatus = 'idle';
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted);
  }

  Future<void> _loadWebView() async {
    await _controller.loadFlutterAsset('assets/index.html');
    setState(() {
      _webViewVisible = true;
    });
  }

  void _confirmNative() {
    setState(() {
      _nativeStatus = 'confirmed';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bridge Fixture'),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Semantics(
              identifier: 'load_webview_btn',
              child: ElevatedButton(
                key: const Key('load_webview_btn'),
                onPressed: _loadWebView,
                child: const Text('Load WebView'),
              ),
            ),
          ),
          if (_webViewVisible)
            Expanded(
              child: WebViewWidget(controller: _controller),
            ),
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Semantics(
              identifier: 'native_confirm_btn',
              child: ElevatedButton(
                key: const Key('native_confirm_btn'),
                onPressed: _confirmNative,
                child: const Text('Confirm Native'),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0),
            child: Semantics(
              identifier: 'native_status_text',
              child: Text(
                _nativeStatus,
                key: const Key('native_status_text'),
                style: const TextStyle(fontSize: 18),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
