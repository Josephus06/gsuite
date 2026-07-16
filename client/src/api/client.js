import axios from 'axios';
import { Capacitor } from '@capacitor/core';

// A Capacitor app has no same-origin server to be relative to -- it loads the bundled
// dist/ files from a local scheme (https://localhost on Android), so a relative '/api'
// would hit that local scheme instead of any real backend. Native builds point at the
// live production API instead; the web build (dev + browser deploy) is unaffected.
const baseURL = Capacitor.isNativePlatform() ? 'https://gsuitev2.graphicstar.ph/api' : '/api';
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
