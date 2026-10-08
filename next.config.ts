/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // Short address for Control Panel: /control/1 -> /control/11111111-1111-1111-1111-111111111111
      {
        source: '/control/1',
        destination: '/control/11111111-1111-1111-1111-111111111111',
        permanent: true,
      },
      // Short address for OBS/YoloBox View: /view/1 -> /view/11111111-1111-1111-1111-111111111111
      {
        source: '/view/1',
        destination: '/view/11111111-1111-1111-1111-111111111111',
        permanent: true,
      },
      // Ultra-short shortcuts (optional)
      {
        source: '/c',
        destination: '/control/11111111-1111-1111-1111-111111111111',
        permanent: true,
      },
      {
        source: '/v',
        destination: '/view/11111111-1111-1111-1111-111111111111',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;