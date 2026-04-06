/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Sharp is used server-side for image resizing — exclude from client bundle
    serverComponentsExternalPackages: ['sharp'],
  },
};

export default nextConfig;
