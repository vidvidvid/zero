//! Unlock the display's native refresh rate in WKWebView.
//!
//! WKWebView clamps rendering updates to ~60fps regardless of the panel it is
//! drawn on. Measured on this machine (M3 Max, Liquid Retina XDR, macOS 26.5.1):
//! an empty `requestAnimationFrame` loop reports 120fps in Safari and 59fps in
//! zero, twelve and twenty-five seconds after load, with nothing else running.
//! So it is not our workload — every frame we draw is simply shown half as
//! often as a native app's.
//!
//! Safari turns the clamp off internally through a WebKit feature flag,
//! `PreferPageRenderingUpdatesNear60FPSEnabled`. There is no public API for it,
//! so this walks `+[WKPreferences _features]` and flips it on the live
//! preferences object. Being private, every step is guarded by a
//! `respondsToSelector:` check — if a macOS update renames or removes any of
//! this, we no-op back to 60fps rather than crashing.
//!
//! Note this rules the app out of the Mac App Store, which zero is not headed
//! for. Widely-cited advice says macOS 26 removed the clamp and makes this
//! unnecessary; the measurements above are from macOS 26.5.1, so that is not
//! true here.

#[cfg(target_os = "macos")]
pub fn unlock(webview: *mut std::ffi::c_void) -> Result<(), &'static str> {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use std::ffi::{c_char, CStr};

    const FLAG: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

    if webview.is_null() {
        return Err("null webview");
    }

    unsafe {
        let webview: *mut AnyObject = webview.cast();

        let config: Option<Retained<AnyObject>> = msg_send![webview, configuration];
        let config = config.ok_or("no configuration")?;
        let prefs: Option<Retained<AnyObject>> = msg_send![&*config, preferences];
        let prefs = prefs.ok_or("no preferences")?;

        // both halves of this are private and could vanish in any OS update
        let responds: Bool = msg_send![&*prefs, respondsToSelector: sel!(_setEnabled:forFeature:)];
        if !responds.as_bool() {
            return Err("_setEnabled:forFeature: is gone");
        }
        let class = AnyClass::get(c"WKPreferences").ok_or("no WKPreferences class")?;
        // `_features` is a class method, so it lives on the metaclass
        if !class.metaclass().responds_to(sel!(_features)) {
            return Err("_features is gone");
        }

        let features: Option<Retained<AnyObject>> = msg_send![class, _features];
        let features = features.ok_or("no features")?;
        let count: usize = msg_send![&*features, count];

        for i in 0..count {
            let feature: Option<Retained<AnyObject>> = msg_send![&*features, objectAtIndex: i];
            let Some(feature) = feature else { continue };
            let has_key: Bool = msg_send![&*feature, respondsToSelector: sel!(key)];
            if !has_key.as_bool() {
                continue;
            }
            let key: Option<Retained<AnyObject>> = msg_send![&*feature, key];
            let Some(key) = key else { continue };
            let utf8: *const c_char = msg_send![&*key, UTF8String];
            if utf8.is_null() || CStr::from_ptr(utf8).to_bytes() != FLAG.as_bytes() {
                continue;
            }
            let _: () = msg_send![&*prefs, _setEnabled: Bool::NO, forFeature: &*feature];
            return Ok(());
        }
    }

    Err("flag not present in this WebKit build")
}
