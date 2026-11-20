import axios from 'axios';
import { Capacitor } from '@capacitor/core';

// The Android app normally loads the live site itself (capacitor.config.json server.url), so
// it is same-origin with the API and a relative '/api' is right -- isNativePlatform() is true
// there too, which is why the test is the page's host rather than the platform. Only a build
// running from the APK's own bundled files (https://localhost) has no server to be relative
// to and needs the absolute production URL.
const bundledApp = Capacitor.isNativePlatform() && window.location.hostname === 'localhost';
const baseURL = bundledApp ? 'https://gsuite.graphicstar.ph/api' : '/api';
const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // The device gate (server lib/deviceGate.js) switched on, or this device's access was removed,
    // while the app was open: reload, and T1S becomes unreachable on this device as it should.
    // (Not from the APK's bundled files: there the page is not the site, so a reload cannot help.)
    if (!bundledApp && err.response?.status === 404 && err.response?.data?.code === 'DEVICE_NOT_REGISTERED') {
      window.location.reload();
      return new Promise(() => {});
    }
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
