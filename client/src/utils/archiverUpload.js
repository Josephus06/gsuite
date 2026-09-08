// Reads a picked file into the shape the Files API expects.
//
// Shared by the upload form and the new-version dialog so both enforce the same limit and send the
// same payload -- two copies of this would drift, and the one that drifts is the one that lets a
// 40MB file through to be rejected by the server after a long upload.
//
// The size is checked BEFORE reading, so an oversized file fails instantly rather than after the
// browser has spent time base64-encoding something that was never going to be accepted.
export function readFileAsBase64(file, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('No file chosen.')); return; }
    if (maxBytes && file.size > maxBytes) {
      reject(new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => {
      // readAsDataURL yields "data:<mime>;base64,<payload>". The server strips the prefix itself,
      // but the split is done here too so the mime type can be taken from the browser's own
      // sniffing rather than trusted from the file extension alone.
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_data: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export default readFileAsBase64;
