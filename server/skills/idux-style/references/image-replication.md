# IDux screenshot replication

Use this workflow when the user supplies a page screenshot:

1. Verify that the selected model can inspect images.
2. Treat the first image as the full reference page and any crops as read-only magnification aids.
3. Classify the page pattern before generating. The current controlled renderer accepts management list pages; reject dashboards, login pages, complex forms, detail pages, and unreadable screenshots.
4. Extract visible navigation direction, title hierarchy, primary action, overview-card count, toolbar arrangement, table columns, density, surface style, and light/dark theme.
5. Preserve the user's requested business object when screenshot text conflicts with the written request.
6. Replace sensitive or personal values with clearly fictional demonstration data. Preserve safe labels and formats.
7. Store only image and analysis hashes in generation evidence. Never copy the image data URL or raw visual inventory into exported evidence.
8. Render from the validated blueprint, then compare the reference against both 1920×1080 and 1366×768 screenshots.

Do not pursue pixel similarity at the expense of IDux component behavior, readable density, accessibility, or safe data handling.
