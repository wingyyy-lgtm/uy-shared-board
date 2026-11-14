import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev badge would sit on top of the composer during screen
  // recordings. Errors and compile output are still shown without it.
  devIndicators: false,
};

export default nextConfig;
