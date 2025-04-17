# WhatsApp Bulk Messenger

A WhatsApp bulk messaging application that allows you to send messages to multiple numbers at once using either the Venom Bot library or direct WhatsApp Web integration.

## Features

- Upload a text file with WhatsApp numbers (one per line)
- Compose a single message to send to all numbers
- Two options for sending messages:
  1. Server-based solution with Venom Bot (requires QR code scan)
  2. Simple browser-based solution that works with WhatsApp Web

## Requirements

- Node.js (v14 or higher)
- NPM (v6 or higher)

## Installation

1. Clone or download this repository
2. Navigate to the project directory
3. Install the dependencies:

```bash
npm install
```

## Usage - Option 1 (Server-based with Venom Bot)

This method requires running a Node.js server:

1. Start the application:

```bash
npm start
```

2. Open your browser and go to: `http://localhost:3000`

3. Follow the on-screen instructions:
   - Click "Connect WhatsApp" and scan the QR code with your WhatsApp mobile app
   - Upload a text file with phone numbers (one per line with country code, e.g., 12345678901)
   - Enter the message you want to send
   - Click "Send Messages" to start sending

**Note:** If you encounter issues with the server-based solution, try Option 2 below.

## Usage - Option 2 (Simple Browser-based)

For a simpler approach that doesn't require running a server:

1. Simply open the file `simple-whatsapp.html` in your browser
2. Follow the on-screen instructions:
   - Upload a text file with phone numbers
   - Enter your message
   - Open WhatsApp Web in another tab and login
   - Click "Send Messages" to start the process
   - For each number, a new WhatsApp Web tab will open with your message pre-filled

## Text File Format

The text file should contain one phone number per line. Each number should include the country code without any special characters. For example:

```
12345678901
23456789012
34567890123
```

## Notes

- The app doesn't store any data, it only reads the numbers from the uploaded file and sends messages
- For authentication, it uses WhatsApp Web's QR code scanning
- The simple browser-based version relies on the browser's ability to open new tabs, so you may need to allow pop-ups 