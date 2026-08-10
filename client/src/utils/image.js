// Resizes/center-crops a user-picked image file down to a small square JPEG data URL
// entirely in the browser (canvas), so the server never has to handle multipart uploads
// or file storage -- the resulting data URL is small enough to send as plain JSON and
// store inline in the DB (see server/src/routes/auth.js's PUT /me/avatar).
// Same idea as fileToSquareDataUrl, but keeps the original aspect ratio and only bounds the
// longest edge -- newsfeed photos are landscape/portrait, not avatars, so center-cropping to a
// square would throw away most of the picture. Result still goes over as a JSON data URL and
// lands in feed_posts.image_data.
export function fileToScaledDataUrl(file, maxEdge = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file.'));
    };
    img.src = objectUrl;
  });
}

export function fileToSquareDataUrl(file, size = 240, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file.'));
    };
    img.src = objectUrl;
  });
}
