/* ICT Gold AI — Service Worker for Netlify (place at site root) */
self.addEventListener("install", function (event) {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("message", function (event) {
  if (!event.data) return;
  if (event.data.type === "ICT_SHOW_NOTIFICATION") {
    event.waitUntil(
      self.registration.showNotification(
        event.data.title || "ICT Gold Signal",
        event.data.options || { body: "", tag: "ict-local" }
      )
    );
  }
  if (event.data.type === "SKIP_WAITING") self.skipWaiting();
});

try {
  importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js");
  firebase.initializeApp({
    apiKey: "AIzaSyCj5SD_7TcUm8YRuUkshBtAhuz98mfqYCo",
    authDomain: "ict-signal.firebaseapp.com",
    projectId: "ict-signal",
    storageBucket: "ict-signal.firebasestorage.app",
    messagingSenderId: "891260886795",
    appId: "1:891260886795:web:8e084446f8f3a53ce20c0e",
    measurementId: "G-YQVP6MTMJ7"
  });
  firebase.messaging().onBackgroundMessage(function (payload) {
    var title =
      (payload.notification && payload.notification.title) ||
      (payload.data && payload.data.title) ||
      "ICT Gold Signal";
    var body =
      (payload.notification && payload.notification.body) ||
      (payload.data && payload.data.body) ||
      "New ICT signal";
    return self.registration.showNotification(title, {
      body: body,
      data: payload.data || {},
      tag: (payload.data && payload.data.tag) || "ict-fcm",
      renotify: true
    });
  });
} catch (e) {
  console.log("[ICT SW] Firebase optional", e);
}
