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
