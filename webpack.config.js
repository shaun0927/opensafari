const path = require('path');
const nodeExternals = require('webpack-node-externals');
const webpack = require('webpack');

module.exports = [
  // Server bundle
  {
    name: 'server',
    entry: './src/index.ts',
    target: 'node',
    mode: 'production',
    devtool: 'source-map',
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, 'dist'),
      library: { type: 'commonjs2' },
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
    },
    externals: [nodeExternals()],
  },
  // CLI bundle
  {
    name: 'cli',
    entry: './cli/index.ts',
    target: 'node',
    mode: 'production',
    devtool: 'source-map',
    output: {
      filename: 'cli/index.js',
      path: path.resolve(__dirname, 'dist'),
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [{
        test: /\.ts$/,
        use: { loader: 'ts-loader', options: { configFile: 'tsconfig.cli.json' } },
        exclude: /node_modules/,
      }],
    },
    externals: [nodeExternals()],
    plugins: [
      new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true }),
    ],
  },
];
