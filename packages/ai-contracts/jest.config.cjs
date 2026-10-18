module.exports = {
    rootDir: __dirname,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tests/**/*.test.ts'],
    transform: {'^.+\\.tsx?$': ['ts-jest', {tsconfig: '<rootDir>/tsconfig.test.json'}]},
    clearMocks: true,
};
