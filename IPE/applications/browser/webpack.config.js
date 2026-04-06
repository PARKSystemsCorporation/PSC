/**
 * Custom Webpack configuration for Gemma Theia IDE
 * Extends the default Theia browser webpack config
 */
const theiaConfig = require('@theia/cli/configs/webpack.config');

module.exports = (env, argv) => {
    const config = theiaConfig(env, argv);

    // Add CSS loader for our custom mobile styles
    config.module.rules.push({
        test: /\.css$/,
        include: /gemma-mobile-ui/,
        use: ['style-loader', 'css-loader']
    });

    // Performance hints for production
    if (argv.mode === 'production') {
        config.performance = {
            hints: 'warning',
            maxAssetSize: 5 * 1024 * 1024,
            maxEntrypointSize: 5 * 1024 * 1024
        };
    }

    return config;
};
