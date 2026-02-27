/**
 * Photo loader — loads landscape photographs for silhouette extraction.
 * Falls back to Unsplash CDN if local files aren't available.
 */

const SampleGenerator = (() => {

  const PHOTOS = {
    city: {
      local: 'assets/photos/city.jpg',
      remote: 'https://images.unsplash.com/photo-1696605837496-956432e62e22?w=1200&h=675&fit=crop',
    },
    mountains: {
      local: 'assets/photos/mountains.jpg',
      remote: 'https://images.unsplash.com/photo-1658771703545-0f3e45ad8284?w=1200&h=675&fit=crop',
    },
    forest: {
      local: 'assets/photos/forest.jpg',
      remote: 'https://images.unsplash.com/photo-1578350716699-228db946f488?w=1200&h=675&fit=crop',
    },
  };

  const cache = {};

  async function generate(canvas, type) {
    const config = PHOTOS[type];
    if (!config) return;

    let img = cache[type];
    if (!img) {
      img = await loadImage(config.local, config.remote);
      cache[type] = img;
    }

    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Cover-fit
    const s = Math.max(w / img.width, h / img.height);
    const sw = img.width * s, sh = img.height * s;
    ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh);
  }

  function loadImage(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        // Fallback to remote CDN
        const img2 = new Image();
        img2.crossOrigin = 'anonymous';
        img2.onload = () => resolve(img2);
        img2.onerror = reject;
        img2.src = remotePath;
      };
      img.src = localPath;
    });
  }

  return { generate, PHOTOS };
})();
