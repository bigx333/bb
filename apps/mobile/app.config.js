module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_BB_NOTIFICATION_TRACE !== "1") return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios.infoPlist,
        UIFileSharingEnabled: true,
        LSSupportsOpeningDocumentsInPlace: true,
      },
    },
  };
};
