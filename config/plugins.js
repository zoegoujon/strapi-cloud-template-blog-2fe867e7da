module.exports = ({ env })=>({
  upload: {
    config: {
      providerOptions: {
        localServer: {
          maxage: 300000
        },
      },
      sizeLimit: 250 * 1024 * 1024, // 256mb in bytes
      breakpoints: {
        xlarge: 1920,
        large: 1000,
        medium: 750,
        small: 500,
        xsmall: 64
      },
      security: {
        allowedTypes: ['image/*', 'application/*'],
        deniedTypes: ['application/x-sh', 'application/x-dosexec']
      },
    },
  },
  "users-permissions": {
    config: {
      register: {
        allowedFields: ["first_name", "last_name"], // add your custom field names here
      },
    },
  },
});