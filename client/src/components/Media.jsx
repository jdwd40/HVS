import React from 'react';

// Renders a media asset: real <video> for playable files, <img> otherwise.
export default function Media({ path: relPath, alt = '', video = false, className }) {
  if (!relPath) return null;
  const src = `/media/${relPath}`;
  const playable = /\.(mp4|webm|mov)$/i.test(relPath);
  if (video && playable) {
    return <video src={src} controls loop muted playsInline className={className} />;
  }
  return <img src={src} alt={alt} className={className} />;
}
