//! The traffic lights, centred on whatever axis the top bar has.
//!
//! macOS draws close/minimise/zoom itself and parks them where a 28pt system
//! titlebar wants them. zero's bar is 40pt, and it is not a fixed 40: the UI
//! zoom (⌘+/⌘-) scales every point in the webview, so at 1.5 the bar stands
//! 60pt tall and at 0.5 it would stand 20 — and the buttons, which belong to
//! the window rather than to the page, do not move with it. Zoomed in they
//! ride above the middle; zoomed out they hang below the bar entirely and sit
//! over the panel. So the bar tells us its height and we put them on its axis.
//!
//! **Two hands are on these buttons, and the split is the whole trick.** tao
//! re-applies `trafficLightPosition` from tauri.conf.json on every redraw: it
//! sets the titlebar container's height to 14 + `y` and each button's *x*, and
//! never touches their *y*, reading the rest of the frame back as it found it.
//! Anything we wrote to x, or to that container, would be gone by the next
//! frame — but y survives, and y is the whole of what we need. Which turns
//! that config `y` into something other than it looks: it is not where the
//! buttons go any more, it is how deep the band they may be moved within is,
//! and it has to stay deep enough for the lowest axis we can be asked for.
//! A button whose centre goes below 14 + `y` still draws, but stops taking
//! clicks — it has left its superview's bounds — so the number is set for the
//! deepest bar zoom can ask for: 40px at zoom 2 is 80pt of window, an axis at
//! 40, a bottom edge at 47, and `y` is 34 for a band of 48. Raising the zoom
//! ceiling in App.tsx past 2 means raising that too, and nothing checks.
//!
//! There is a third hand on them, and it is the one that has to be answered
//! rather than divided with: AppKit lays the titlebar out itself on every
//! frame of a live resize and puts the buttons back at its own default — 9pt
//! up from the bottom of that band, which is only the middle of the bar if
//! the band was cut to match. Correcting that from the resize event is a
//! frame late and reads as the buttons flickering between two places while
//! the edge is dragged, both hands writing every frame. So the correction
//! goes where the move does: `watch` puts it on the frame-change
//! notification, so it lands inside the same layout pass and nothing is ever
//! drawn out of place.
//!
//! Everything here is a no-op off macOS, where there are no such buttons.

#[cfg(target_os = "macos")]
use std::sync::Mutex;

/// The last height the bar reported, so that the watcher below can put the
/// buttons back without asking the frontend where they go. 40 until it says
/// otherwise — the height at zoom 1, which is a guess and wrong for anyone
/// who has zoomed, so the bar reports on mount rather than waiting for the
/// next ⌘+/⌘- to make it true.
#[cfg(target_os = "macos")]
static BAR: Mutex<f64> = Mutex::new(40.0);

/// Put the three buttons' centres `bar / 2` below the top of the window.
///
/// Absolute, never a nudge from where they are now. A delta is the obvious
/// way to write this and it comes apart on a live resize: the buttons are
/// measured against a window whose height has already changed and whose
/// titlebar has not been laid out into it yet, so every read is stale by the
/// resize and every correction adds that on again — the buttons jump off up
/// the screen while the edge is being dragged. Their own superview is the
/// stable frame to measure in: it fills the container tao pins to the top of
/// the window on every redraw, so its height is the distance to that top,
/// whatever the window is doing.
#[cfg(target_os = "macos")]
pub fn centre(ns_window: *mut std::ffi::c_void, bar: f64) -> Result<(), &'static str> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_core_foundation::{CGPoint, CGRect};

    if ns_window.is_null() {
        return Err("no window");
    }
    if !(bar.is_finite() && bar > 0.0) {
        return Err("bar height is not a height");
    }
    *BAR.lock().map_err(|_| "poisoned")? = bar;

    unsafe {
        let window: *mut AnyObject = ns_window.cast();

        // Two views above a button: the band it sits in (AppKit's titlebar
        // view) and the container tao pins to the top of the window on every
        // redraw. The band is the frame the buttons are positioned in, and it
        // is only the same thing as the container until AppKit lays the
        // titlebar out again — a live resize — after which it is back to its
        // natural height and sitting at the *bottom* of the container, 16pt
        // down. Placing a button correctly inside a band that has itself
        // moved puts it 16pt low and keeps it there, every later placement
        // agreeing with the one before. So the band is put back over the
        // container first, and only then does the middle of it mean the
        // middle of the bar.
        let first: Option<Retained<AnyObject>> = msg_send![window, standardWindowButton: 0usize];
        let first = first.ok_or("this window has no standard buttons")?;
        let band: Option<Retained<AnyObject>> = msg_send![&*first, superview];
        let band = band.ok_or("a button with no titlebar to sit in")?;
        let container: Option<Retained<AnyObject>> = msg_send![&*band, superview];
        let container = container.ok_or("a titlebar outside anything")?;

        // The container collapses too — it flips between the depth tao gives
        // it and AppKit's own while an edge is being dragged. Placing against
        // its top rather than its height means either reading lands the
        // buttons in the same place, but a shallow one still clamps a deep
        // axis: a bar of 80pt (zoom 2) wants 47 of depth, and 32 will not do.
        // So it is grown back to what the axis needs, top held still, and
        // never past the 48 tao would restore anyway — nothing to fight over.
        let mut over = { let r: CGRect = msg_send![&*container, bounds]; r };
        let tall = { let r: CGRect = msg_send![&*first, frame]; r.size.height };
        let needs = (bar + tall) / 2.0;
        if over.size.height + 0.5 < needs {
            let mut grown: CGRect = msg_send![&*container, frame];
            grown.origin.y += grown.size.height - needs;
            grown.size.height = needs;
            let _: () = msg_send![&*container, setFrame: grown];
            over.size.height = needs;
        }
        let sits = { let r: CGRect = msg_send![&*band, frame]; r };
        if (sits.size.height - over.size.height).abs() > 0.5 || sits.origin.y.abs() > 0.5 {
            let full = CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: over.size,
            };
            let _: () = msg_send![&*band, setFrame: full];
        }
        let depth = over.size.height;

        // NSWindowButton: close, miniaturise, zoom
        for tag in 0usize..3 {
            let button: Option<Retained<AnyObject>> = msg_send![window, standardWindowButton: tag];
            let Some(button) = button else {
                return Err("this window has no standard buttons");
            };
            let mut frame: CGRect = msg_send![&*button, frame];
            // y counts up from the bottom, so this is the top of the band,
            // less the gap that leaves the button's centre on the bar's axis.
            // Never below the band: outside its superview's bounds a view
            // still draws but stops taking clicks.
            let want = (depth - (bar + frame.size.height) / 2.0).max(0.0);
            // Moving a view is what got us called, so a write that changes
            // nothing still has to be skipped — it would post another frame
            // change, and that is a loop rather than a correction.
            if (frame.origin.y - want).abs() > 0.5 {
                frame.origin.y = want;
                let _: () = msg_send![&*button, setFrameOrigin: frame.origin];
            }
        }
    }
    Ok(())
}

/// Keep them there. AppKit resets the buttons to its own default whenever it
/// lays the titlebar out — every frame of a live resize, and on a fullscreen
/// transition — so each one is watched, and the instant its frame changes it
/// is put back on the bar's axis. Synchronously: the notification is posted
/// with no queue, which delivers it on the thread that moved the view, still
/// inside AppKit's layout, so the two writes are one and no frame is drawn
/// with the buttons anywhere else. Registered once, for the life of the app.
#[cfg(target_os = "macos")]
pub fn watch(ns_window: *mut std::ffi::c_void) -> Result<(), &'static str> {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    if ns_window.is_null() {
        return Err("no window");
    }
    unsafe {
        let window: *mut AnyObject = ns_window.cast();
        let hub_class = AnyClass::get(c"NSNotificationCenter").ok_or("no NSNotificationCenter")?;
        let notifications: Option<Retained<AnyObject>> = msg_send![hub_class, defaultCenter];
        let notifications = notifications.ok_or("no notification centre")?;
        let string_class = AnyClass::get(c"NSString").ok_or("no NSString")?;
        let name: Option<Retained<AnyObject>> = msg_send![
            string_class,
            stringWithUTF8String: c"NSViewFrameDidChangeNotification".as_ptr()
        ];
        let name = name.ok_or("no notification name")?;

        // the window outlives everything here, so the block carries it as a
        // number rather than borrowing anything
        let handle = ns_window as usize;
        let block = RcBlock::new(move |_note: *mut AnyObject| {
            let bar = BAR.lock().map(|h| *h).unwrap_or(40.0);
            let _ = centre(handle as *mut std::ffi::c_void, bar);
        });

        // The three buttons, and the band they sit in — AppKit can move that
        // without touching them, and a band that moves takes the buttons with
        // it, so watching only the buttons would miss the move that matters
        // most.
        let mut watched: Vec<Retained<AnyObject>> = Vec::with_capacity(4);
        for tag in 0usize..3 {
            let button: Option<Retained<AnyObject>> = msg_send![window, standardWindowButton: tag];
            let Some(button) = button else {
                return Err("this window has no standard buttons");
            };
            watched.push(button);
        }
        let band: Option<Retained<AnyObject>> = msg_send![&*watched[0], superview];
        if let Some(band) = band {
            watched.push(band);
        }

        for view in &watched {
            let _: () = msg_send![&**view, setPostsFrameChangedNotifications: Bool::YES];
            let token: Option<Retained<AnyObject>> = msg_send![
                &*notifications,
                addObserverForName: &*name,
                object: &**view,
                queue: std::ptr::null::<AnyObject>(),
                usingBlock: &*block,
            ];
            // both of these are wanted for as long as there is a window to
            // watch, which is as long as there is an app
            std::mem::forget(token);
        }
        std::mem::forget(block);
    }
    Ok(())
}

/// The bar reporting where its middle is, in points — its measured height
/// times the zoom, since the webview's points are not the window's once the
/// UI is zoomed. Called on launch and on every ⌘+/⌘-.
#[tauri::command]
pub fn titlebar_height(window: tauri::Window, height: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                if let Ok(ns) = win.ns_window() {
                    // a failure here is a titlebar we couldn't reach, not a
                    // reason to fail the call: the buttons stay where macOS
                    // put them and the app is otherwise unaffected
                    if let Err(e) = centre(ns, height) {
                        println!("[titlebar] traffic lights not centred: {e}");
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, height);
    Ok(())
}
