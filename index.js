const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const venom = require('venom-bot');
const app = express();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { v4: uuidv4 } = require('uuid');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Global client variable to maintain WhatsApp session
let whatsappClient = null;
// Global variable for QR code
let qrCodeData = null;
// Global variables for tracking message sending status
let messageQueue = [];
let sendingInProgress = false;
let sendingResults = {
  success: [],
  failed: [],
  scheduled: [],
  current: null,
  total: 0,
  processed: 0
};

// Global variables for scheduled sending
let scheduleTimeouts = [];
let isScheduling = false;
let scheduleStartTime = null;
let scheduleEndTime = null;
let isScheduleStopped = false;

// Route to serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route to initialize WhatsApp session and get QR code
app.get('/init-whatsapp', async (req, res) => {
  try {
    // Reset QR code
    qrCodeData = null;
    
    // Check if client is already initialized
    if (whatsappClient) {
      console.log('Client already exists, returning success message');
      return res.json({ message: 'WhatsApp client already initialized' });
    }
    
    console.log('Starting WhatsApp client initialization...');
    
    // Set up a QR code response handler
    let qrResponseSent = false;
    
    // Create folders if they don't exist
    if (!fs.existsSync('./tokens')) {
      fs.mkdirSync('./tokens', { recursive: true });
    }
    
    if (!fs.existsSync('./uploads')) {
      fs.mkdirSync('./uploads', { recursive: true });
    }
    
    try {
      // Create the client
      venom
        .create(
          'whatsapp-session',
          (base64Qr, asciiQR, attempts, urlCode) => {
            console.log('QR Code received, attempt:', attempts);
            qrCodeData = base64Qr;
            
            // Send QR code to the client once
            if (!qrResponseSent) {
              console.log('Sending QR code to client');
              res.json({ qrCode: base64Qr });
              qrResponseSent = true;
            }
          },
          (statusSession, session) => {
            console.log('Status Session:', statusSession);
          },
          {
            folderNameToken: 'tokens',
            headless: true,
            useChrome: false,
            debug: false,
            logQR: false,
            browserArgs: ['--no-sandbox'],
            disableWelcome: true,
            createPathFileToken: true  // Make sure token path exists
          }
        )
        .then((client) => {
          whatsappClient = client;
          console.log('Client initialized successfully');
          
          // If response hasn't been sent yet (rare case), send it now
          if (!qrResponseSent) {
            console.log('Sending success response after client initialization');
            res.json({ message: 'WhatsApp client initialized' });
            qrResponseSent = true;
          }
        })
        .catch((error) => {
          console.error('Error when creating venom client:', error);
          
          // If response hasn't been sent yet, send error
          if (!qrResponseSent) {
            console.log('Sending error response after venom.create failure');
            res.status(500).json({ error: 'Failed to initialize WhatsApp client: ' + error.message });
            qrResponseSent = true;
          }
        });
    } catch (venomError) {
      console.error('Exception in venom.create:', venomError);
      if (!qrResponseSent) {
        res.status(500).json({ error: 'Exception in WhatsApp initialization: ' + venomError.message });
        qrResponseSent = true;
      }
    }
    
    // Set a timeout in case venom never calls the callbacks
    setTimeout(() => {
      if (!qrResponseSent) {
        console.log('Response timeout reached, sending timeout response');
        res.status(408).json({ error: 'QR code generation timed out' });
        qrResponseSent = true;
      }
    }, 30000);
    
  } catch (error) {
    console.error('Error initializing WhatsApp (outer try/catch):', error);
    res.status(500).json({ error: 'Failed to initialize WhatsApp: ' + error.message });
  }
});

// Route to check session status
app.get('/check-session', (req, res) => {
  if (whatsappClient) {
    res.json({ status: 'connected' });
  } else {
    res.json({ status: 'disconnected' });
  }
});

// Route to get QR code
app.get('/get-qrcode', (req, res) => {
  if (qrCodeData) {
    res.json({ qrCode: qrCodeData });
  } else {
    res.status(404).json({ error: 'QR code not generated yet' });
  }
});

// Route to process file upload and send messages
app.post('/send-messages', upload.single('numbersFile'), async (req, res) => {
  try {
    if (!whatsappClient) {
      return res.status(400).json({ error: 'WhatsApp client not initialized. Please scan the QR code first.' });
    }

    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('Created uploads directory');
    }

    // Validate file and message
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a file with numbers' });
    }

    // Store the file path in a more accessible way
    const uploadedFilePath = path.resolve(req.file.path);
    console.log(`File uploaded successfully: ${uploadedFilePath}`);

    // Only clean up old files after confirming we have a new one
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      // Delete all files except the one just uploaded
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        if (file !== req.file.filename && fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
          console.log(`Deleted previous file: ${filePath}`);
        }
      }
    }

    // Get form data
    const { 
      message, 
      useSchedule, 
      scheduleDuration, 
      quietStart1, 
      quietEnd1, 
      quietStart2, 
      quietEnd2 
    } = req.body;
    
    // Get scheduleStartTime separately as a mutable variable
    let scheduleStartTime = req.body.scheduleStartTime;
    
    if (!message) {
      return res.status(400).json({ error: 'Please provide a message to send' });
    }

    // Read the uploaded file
    const fileContent = fs.readFileSync(uploadedFilePath, 'utf8');
    
    // Parse phone numbers from the file (assuming one number per line)
    const phoneNumbers = fileContent.split(/\r?\n/).filter(num => num.trim() !== '');
    
    if (phoneNumbers.length === 0) {
      // Remove the temporary file
      fs.unlinkSync(uploadedFilePath);
      return res.status(400).json({ error: 'No valid phone numbers found in file' });
    }
    
    // Check if using schedule mode
    const shouldSchedule = useSchedule === 'true';
    
    // Process all numbers without limitation
    const processNumbers = shouldSchedule 
      ? phoneNumbers 
      : phoneNumbers;
    
    // Initialize the sending results
    sendingResults = {
      success: [],
      failed: [],
      scheduled: [],
      current: null,
      total: processNumbers.length,
      processed: 0
    };
    
    // Parse duration (in hours) or use default 24 hours
    const durationHours = scheduleDuration && !isNaN(parseInt(scheduleDuration)) 
      ? Math.min(Math.max(parseInt(scheduleDuration), 1), 168) // Between 1 and 168 hours (1 week max)
      : 24;
    
    // Set schedule times if using schedule
    if (shouldSchedule) {
      isScheduling = true;
      isScheduleStopped = false;
      
      // Use current time as start time
      let startTimeObj = new Date();
      
      // Calculate duration in milliseconds
      const durationMs = durationHours * 60 * 60 * 1000;
      
      // Set schedule start and end times
      scheduleStartTime = startTimeObj;
      scheduleEndTime = new Date(scheduleStartTime.getTime() + durationMs);
      
      console.log(`Scheduling messages over ${durationHours} hours to avoid spam detection`);
      
      // Create a random schedule over the specified duration
      const schedule = createRandomSchedule(processNumbers, durationMs);
      
      // Add each number to scheduled list
      schedule.forEach(item => {
        const scheduledTime = new Date(scheduleStartTime.getTime() + item.delay);
        sendingResults.scheduled.push({
          id: uuidv4(),
          number: item.number,
          scheduledTime: scheduledTime.toISOString(),
          delay: item.delay,
          status: 'scheduled'
        });
      });
      
      // Start the scheduling process with the resolved file path
      console.log(`Starting scheduled sending of ${processNumbers.length} messages over ${durationHours} hours`);
      startScheduledSending(schedule, message, uploadedFilePath);
    } else {
      // Process messages immediately in background
      console.log(`Starting immediate sending of ${processNumbers.length} messages`);
      processMessages(processNumbers, message, uploadedFilePath);
    }
    
    // Return success immediately, client will poll for status
    res.json({ 
      message: shouldSchedule ? `Messages scheduled for ${durationHours}-hour delivery` : 'Message sending started', 
      totalNumbers: processNumbers.length,
      isScheduled: shouldSchedule
    });
    
  } catch (error) {
    console.error('Error sending messages:', error);
    res.status(500).json({ error: 'Failed to send messages: ' + error.message });
  }
});

// Route to get message sending status
app.get('/message-status', (req, res) => {
  // Add schedule timing information if we're in scheduling mode
  if (isScheduling) {
    const now = new Date();
    const scheduleInfo = {
      startTime: scheduleStartTime ? scheduleStartTime.toISOString() : null,
      endTime: scheduleEndTime ? scheduleEndTime.toISOString() : null,
      currentTime: now.toISOString(),
      progress: scheduleStartTime && scheduleEndTime ? 
        (now - scheduleStartTime) / (scheduleEndTime - scheduleStartTime) * 100 : 0,
      isScheduleStopped: isScheduleStopped
    };
    
    // Add all scheduled messages with their status and time info
    if (sendingResults.scheduled && sendingResults.scheduled.length > 0) {
      // Sort scheduled messages by time
      const sortedScheduled = [...sendingResults.scheduled]
        .filter(item => item.status === 'scheduled')
        .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
      
      // Find the next message to be sent
      const nextScheduled = sortedScheduled.length > 0 ? sortedScheduled[0] : null;
      
      // Add to schedule info
      scheduleInfo.nextMessage = nextScheduled ? {
        number: nextScheduled.number,
        scheduledTime: nextScheduled.scheduledTime,
        timeUntil: new Date(nextScheduled.scheduledTime) - now,
        formattedTimeUntil: formatTimeUntil(new Date(nextScheduled.scheduledTime) - now)
      } : null;
      
      // Add all upcoming messages with their time info
      scheduleInfo.upcomingMessages = sortedScheduled.map(msg => ({
        id: msg.id,
        number: msg.number,
        scheduledTime: msg.scheduledTime,
        timeUntil: new Date(msg.scheduledTime) - now,
        formattedTimeUntil: formatTimeUntil(new Date(msg.scheduledTime) - now)
      }));
      
      // Find the currently processing message if current is not set
      if (!sendingResults.current) {
        const processingMessage = sendingResults.scheduled.find(item => item.status === 'processing');
        if (processingMessage) {
          sendingResults.current = processingMessage.number;
        }
      }
    }
    
    res.json({
      ...sendingResults,
      scheduleInfo
    });
  } else {
    // For non-scheduled mode, check if we need to find the currently processing message
    if (!sendingResults.current && sendingResults.total > 0 && sendingResults.processed < sendingResults.total) {
      // If there's no current message but processing is ongoing, check the most recent success/failed
      const latestSuccess = sendingResults.success.length > 0 ? 
        sendingResults.success[sendingResults.success.length - 1] : null;
      const latestFailed = sendingResults.failed.length > 0 ? 
        sendingResults.failed[sendingResults.failed.length - 1] : null;
      
      // Compare timestamps to find the most recent message
      if (latestSuccess && latestFailed) {
        const successTime = new Date(latestSuccess.timestamp).getTime();
        const failedTime = new Date(latestFailed.timestamp).getTime();
        if (successTime > failedTime) {
          // Calculate the next number (assuming success was the last one processed)
          sendingResults.current = `Next after ${latestSuccess.number}`;
        } else {
          sendingResults.current = `Next after ${latestFailed.number}`;
        }
      } else if (latestSuccess) {
        sendingResults.current = `Next after ${latestSuccess.number}`;
      } else if (latestFailed) {
        sendingResults.current = `Next after ${latestFailed.number}`;
      }
    }
    
    res.json(sendingResults);
  }
});

// Helper function to format time until message sending
function formatTimeUntil(timeMs) {
  if (timeMs <= 0) return "Sending now";
  
  const seconds = Math.floor((timeMs / 1000) % 60);
  const minutes = Math.floor((timeMs / (1000 * 60)) % 60);
  const hours = Math.floor((timeMs / (1000 * 60 * 60)) % 24);
  
  return `${hours}h ${minutes}m ${seconds}s`;
}

// Route to stop scheduled sending
app.get('/stop-schedule', (req, res) => {
  try {
    isScheduleStopped = true;
    clearAllSchedules();
    
    res.json({ 
      message: 'Scheduled message sending stopped',
      remainingScheduled: sendingResults.scheduled.filter(item => item.status === 'scheduled').length
    });
  } catch (error) {
    console.error('Error stopping schedule:', error);
    res.status(500).json({ error: 'Failed to stop scheduled messages' });
  }
});

// Route to get all scheduled messages
app.get('/scheduled-messages', (req, res) => {
  try {
    // Only return messages that are still scheduled (not sent or failed)
    const scheduledMessages = sendingResults.scheduled.filter(item => item.status === 'scheduled');
    
    res.json({
      total: scheduledMessages.length,
      scheduleActive: isScheduling && !isScheduleStopped,
      startTime: scheduleStartTime ? scheduleStartTime.toISOString() : null,
      endTime: scheduleEndTime ? scheduleEndTime.toISOString() : null,
      messages: scheduledMessages
    });
  } catch (error) {
    console.error('Error getting scheduled messages:', error);
    res.status(500).json({ error: 'Failed to retrieve scheduled messages' });
  }
});

// Route to cancel a specific scheduled message
app.delete('/scheduled-message/:id', (req, res) => {
  try {
    const messageId = req.params.id;
    
    // Find the message in the scheduled list
    const messageIndex = sendingResults.scheduled.findIndex(item => item.id === messageId && item.status === 'scheduled');
    
    if (messageIndex === -1) {
      return res.status(404).json({ error: 'Scheduled message not found or already processed' });
    }
    
    // Mark the message as cancelled
    sendingResults.scheduled[messageIndex].status = 'cancelled';
    
    // Return success
    res.json({ 
      message: 'Scheduled message cancelled',
      cancelledMessage: sendingResults.scheduled[messageIndex]
    });
  } catch (error) {
    console.error('Error cancelling scheduled message:', error);
    res.status(500).json({ error: 'Failed to cancel scheduled message' });
  }
});

// Create a random schedule spread over specified period with anti-spam techniques
function createRandomSchedule(numbers, periodMs) {
  // Initialize schedule array
  const schedule = [];
  
  // Create a copy of numbers array to avoid modifying the original
  const numbersArray = Array.isArray(numbers) ? [...numbers] : [numbers];
  
  // Calculate average time between messages
  const avgDelay = periodMs / numbersArray.length;
  
  // Track time clusters to avoid too many messages in a short period
  const timeSlots = new Map();
  const slotSize = 15 * 60 * 1000; // 15-minute slots
  
  // Create time slots with intelligent randomness for spam prevention
  for (let i = 0; i < numbersArray.length; i++) {
    // Base delay is progressive through the period
    const baseDelay = i * avgDelay;
    
    // Add randomness (± 30% of the average delay)
    let randomFactor = (Math.random() * 0.6) - 0.3; // Random between -0.3 and 0.3
    
    // Add "natural clusters" - people tend to send messages in groups
    if (Math.random() > 0.7 && i > 0) {
      // 30% chance of sending relatively close to the previous message
      randomFactor = (Math.random() * 0.2) - 0.1; // Much smaller variation ±10%
    }
    
    // Calculate the delay
    let delay = Math.max(0, Math.round(baseDelay + (randomFactor * avgDelay)));
    
    // Check for slot density to avoid too many messages in a short period
    const slot = Math.floor(delay / slotSize);
    const slotCount = timeSlots.get(slot) || 0;
    
    // If too many messages in this slot, shift to less populated slots
    if (slotCount > 3) { // Max 3 messages in a 15-min window
      const nextSlot = slot + 1;
      const prevSlot = Math.max(0, slot - 1);
      
      // Check which adjacent slot has fewer messages
      const nextSlotCount = timeSlots.get(nextSlot) || 0;
      const prevSlotCount = timeSlots.get(prevSlot) || 0;
      
      if (nextSlotCount <= prevSlotCount && nextSlot * slotSize < periodMs) {
        delay = (nextSlot * slotSize) + Math.floor(Math.random() * slotSize);
      } else if (prevSlot > 0) {
        delay = (prevSlot * slotSize) + Math.floor(Math.random() * slotSize);
      }
    }
    
    // Update the slot count
    const newSlot = Math.floor(delay / slotSize);
    timeSlots.set(newSlot, (timeSlots.get(newSlot) || 0) + 1);
    
    // Ensure delay doesn't exceed the total period
    delay = Math.min(delay, periodMs - 1);
    
    // Ensure minimum delay (at least 1 minute between messages)
    if (i > 0) {
      const minInterval = 60 * 1000; // 1 minute
      const prevDelay = schedule[i-1]?.delay || 0;
      if (delay - prevDelay < minInterval) {
        delay = prevDelay + minInterval + Math.floor(Math.random() * 30000); // Add 1-1.5 minutes
      }
    }
    
    schedule.push({
      number: numbersArray[i],
      delay: delay
    });
  }
  
  // Sort schedule by delay to ensure messages are sent in chronological order
  schedule.sort((a, b) => a.delay - b.delay);
  
  return schedule;
}

// Create a custom schedule that respects quiet hours
function createCustomSchedule(numbers, periodMs, quietHours) {
  // Initialize schedule array
  const schedule = [];
  
  // Create a copy of numbers array to avoid modifying the original
  const numbersArray = Array.isArray(numbers) ? [...numbers] : [numbers];
  
  // Helper function to check if a time is within quiet hours
  const isQuietTime = (hourMinute) => {
    // hourMinute is in format "HH:MM"
    if (!quietHours || quietHours.length === 0) return false;
    
    // Extract hours and minutes from the time string (assuming 24-hour format)
    const [hours, minutes] = hourMinute.split(':').map(num => parseInt(num, 10));
    const timeInMinutes = hours * 60 + minutes;
    
    // Check against each quiet period
    return quietHours.some(period => {
      const [startHours, startMinutes] = period.start.split(':').map(num => parseInt(num, 10));
      const [endHours, endMinutes] = period.end.split(':').map(num => parseInt(num, 10));
      
      const startInMinutes = startHours * 60 + startMinutes;
      let endInMinutes = endHours * 60 + endMinutes;
      
      // Handle cases where quiet period spans midnight
      if (endInMinutes <= startInMinutes) {
        endInMinutes += 24 * 60; // Add a day
        
        // If time is after start, compare with end
        if (timeInMinutes >= startInMinutes) {
          return timeInMinutes <= endInMinutes;
        }
        
        // If time is before end of next day
        if (timeInMinutes <= (endInMinutes - 24 * 60)) {
          return true;
        }
        
        return false;
      }
      
      // Normal case (quiet period within same day)
      return timeInMinutes >= startInMinutes && timeInMinutes <= endInMinutes;
    });
  };
  
  // Function to convert delay (ms) to time of day
  const delayToTimeOfDay = (delay) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0); // Start from midnight
    date.setMilliseconds(delay);
    
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    
    return `${hours}:${minutes}`;
  };
  
  // Function to modify delay if it falls within quiet hours
  const adjustDelayForQuietHours = (delay) => {
    // Convert to ms within a day (0-24h)
    const msInDay = 24 * 60 * 60 * 1000;
    const delayInDay = delay % msInDay;
    
    // Convert to time of day
    const timeOfDay = delayToTimeOfDay(delayInDay);
    
    // If not in quiet hours, keep the delay
    if (!isQuietTime(timeOfDay)) {
      return delay;
    }
    
    // If in quiet hours, find the next available time
    // First, convert to minutes since midnight
    const [hours, minutes] = timeOfDay.split(':').map(num => parseInt(num, 10));
    let timeInMinutes = hours * 60 + minutes;
    
    // Find the end of the current quiet period
    for (const period of quietHours) {
      const [startHours, startMinutes] = period.start.split(':').map(num => parseInt(num, 10));
      const [endHours, endMinutes] = period.end.split(':').map(num => parseInt(num, 10));
      
      const startInMinutes = startHours * 60 + startMinutes;
      let endInMinutes = endHours * 60 + endMinutes;
      
      // Handle periods that span midnight
      if (endInMinutes <= startInMinutes) {
        endInMinutes += 24 * 60;
      }
      
      // If this is the quiet period we're in
      if ((timeInMinutes >= startInMinutes && timeInMinutes <= endInMinutes) ||
          (endInMinutes > 24 * 60 && timeInMinutes <= (endInMinutes - 24 * 60))) {
        // Move to the end of this quiet period
        timeInMinutes = endInMinutes % (24 * 60); // Keep within 24h
        break;
      }
    }
    
    // Convert back to milliseconds
    const newDelayInDay = timeInMinutes * 60 * 1000;
    
    // If the new delay is less than the original, add a day
    if (newDelayInDay < delayInDay) {
      return delay - delayInDay + newDelayInDay + msInDay;
    }
    
    return delay - delayInDay + newDelayInDay;
  };
  
  // Calculate average time between messages (considering the total period)
  const avgDelay = periodMs / numbersArray.length;
  
  // Create time slots with some randomness
  for (let i = 0; i < numbersArray.length; i++) {
    // Base delay is progressive through the period
    const baseDelay = i * avgDelay;
    
    // Add randomness (± 30% of the average delay)
    const randomFactor = (Math.random() * 0.6) - 0.3; // Random between -0.3 and 0.3
    let delay = Math.max(0, Math.round(baseDelay + (randomFactor * avgDelay)));
    
    // Adjust delay if it falls within quiet hours
    if (quietHours && quietHours.length > 0) {
      delay = adjustDelayForQuietHours(delay);
    }
    
    // Ensure delay doesn't exceed the total period
    delay = Math.min(delay, periodMs - 1);
    
    schedule.push({
      number: numbersArray[i],
      delay: delay
    });
  }
  
  // Sort schedule by delay to ensure messages are sent in chronological order
  schedule.sort((a, b) => a.delay - b.delay);
  
  return schedule;
}

// Process a scheduled message at the given time
function startScheduledSending(schedule, message, filePath) {
  console.log(`Setting up schedule for ${schedule.length} messages`);
  // Clear any existing schedules first
  clearAllSchedules();
  
  // Debug info
  if (!fs.existsSync(filePath)) {
    console.error(`WARNING: File path does not exist: ${filePath}`);
    // Try to recover if possible - check if the file might be in uploads directory
    const filename = path.basename(filePath);
    const alternativePath = path.join(__dirname, 'uploads', filename);
    if (fs.existsSync(alternativePath)) {
      console.log(`Found alternative file path: ${alternativePath}`);
      filePath = alternativePath;
    } else {
      console.error('No alternative file path found. Schedule might fail.');
    }
  } else {
    console.log(`File exists at path: ${filePath}`);
  }
  
  // Schedule each message
  schedule.forEach((item, index) => {
    console.log(`Scheduling message to ${item.number} with delay ${item.delay}ms (${Math.round(item.delay/60000)} minutes)`);
    
    const timeout = setTimeout(async () => {
      // If schedule was stopped, don't process
      if (isScheduleStopped) {
        console.log(`Skipping message to ${item.number} because schedule was stopped`);
        return;
      }
      
      // Set the current number being processed in the sending results for real-time UI updates
      // This ensures the UI shows which number is being processed
      sendingResults.current = item.number;
      
      try {
        // Debug check if file still exists
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found at path: ${filePath}`);
        }
        
        console.log(`Processing scheduled message to ${item.number}`);
        
        // Find the message in scheduled list
        const messageIndex = sendingResults.scheduled.findIndex(
          scheduled => scheduled.number === item.number && scheduled.status === 'scheduled'
        );
        
        if (messageIndex !== -1) {
          // Update message status to processing
          sendingResults.scheduled[messageIndex].status = 'processing';
          
          // IMPORTANT: Keep the current number set while sending
          sendingResults.current = item.number;
          
          // Send the message
          const result = await sendMessage(item.number, message);
          
          // Update results based on success or failure
          if (result.success) {
            sendingResults.success.push({
              number: item.number,
              timestamp: new Date().toISOString()
            });
            
            // Update scheduled message status
            sendingResults.scheduled[messageIndex].status = 'sent';
          } else {
            sendingResults.failed.push({
              number: item.number,
              error: result.error || 'Unknown error',
              timestamp: new Date().toISOString()
            });
            
            // Update scheduled message status
            sendingResults.scheduled[messageIndex].status = 'failed';
          }
          
          // Update processed count
          sendingResults.processed++;
        }
      } catch (error) {
        console.error(`Error processing scheduled message to ${item.number}:`, error);
        
        // Add to failed list
        sendingResults.failed.push({
          number: item.number,
          error: error.message || 'Unknown error',
          timestamp: new Date().toISOString()
        });
        
        // Update processed count
        sendingResults.processed++;
        
        // Find and update status in scheduled list
        const messageIndex = sendingResults.scheduled.findIndex(
          scheduled => scheduled.number === item.number && (scheduled.status === 'scheduled' || scheduled.status === 'processing')
        );
        
        if (messageIndex !== -1) {
          sendingResults.scheduled[messageIndex].status = 'failed';
        }
      } finally {
        // Delay clearing the current number to allow UI to display it longer
        // Use a small timeout to keep the number displayed for a short time after sending
        setTimeout(() => {
          sendingResults.current = null;
        }, 1500); // Keep the number visible for 1.5 seconds after processing
      }
    }, item.delay);
    
    // Store timeout ID to be able to clear it later
    scheduleTimeouts.push(timeout);
  });
}

// Process messages synchronously
async function processMessages(numbers, message, filePath) {
  // Save original current status
  const wasScheduling = isScheduling;
  isScheduling = false;
  
  try {
    console.log(`Processing ${numbers.length} messages immediately`);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`File not found at path: ${filePath}. This may cause issues.`);
    }
    
    // Process each number
    for (let i = 0; i < numbers.length; i++) {
      // Allow aborting at any time
      if (isAborted) {
        console.log('Message sending aborted by user');
        break;
      }
      
      const number = numbers[i];
      
      // Update current number with additional info
      sendingResults.current = number;
      
      try {
        console.log(`Sending message to ${number} (${i+1}/${numbers.length})`);
        
        // Send the message
        const result = await sendMessage(number, message);
        
        // Keep the current number set for longer to ensure UI can show it
        sendingResults.current = number;
        
        // Update results
        if (result.success) {
          sendingResults.success.push({
            number,
            timestamp: new Date().toISOString()
          });
        } else {
          sendingResults.failed.push({
            number,
            error: result.error,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error(`Error processing message to ${number}:`, error);
        
        // Add to failed list
        sendingResults.failed.push({
          number,
          error: error.message || 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
      
      // Update processed count
      sendingResults.processed++;
      
      // Do not clear current number between messages - leave it set for the UI
      // This ensures we always show the most recently processed number
      
      // Small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Clean up when done
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Deleted file: ${filePath}`);
      }
    } catch (error) {
      console.error('Error deleting file:', error);
    }
  } catch (error) {
    console.error('Error in processMessages:', error);
  } finally {
    // Delay clearing the current status to allow the UI to show it longer
    setTimeout(() => {
      // Only clear if we're done processing
      if (sendingResults.processed >= sendingResults.total) {
        sendingResults.current = null;
      }
      
      // Restore original scheduling status
      isScheduling = wasScheduling;
    }, 2000); // Keep the number visible for 2 seconds after completing
  }
}

// Clear all scheduled timeouts
function clearAllSchedules() {
  scheduleTimeouts.forEach(timeout => clearTimeout(timeout));
  scheduleTimeouts = [];
}

// Clean up uploads directory by removing all files
function cleanUploadsDirectory() {
  const uploadsDir = path.join(__dirname, 'uploads');
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      if (fs.statSync(filePath).isFile()) {
        try {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old file: ${filePath}`);
        } catch (err) {
          console.error(`Failed to delete file ${filePath}:`, err);
        }
      }
    }
    console.log('Uploads directory cleaned');
  }
}

// Route to delete the uploaded file and clean up all data
app.post('/delete-uploaded-file', (req, res) => {
  try {
    console.log('Starting complete data cleanup');
    
    // Clean up temporary files in uploads directory
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        if (fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
          console.log(`Deleted file: ${filePath}`);
        }
      }
      console.log('All uploaded files deleted');
    }
    
    // Clear scheduled messages
    if (isScheduling) {
      clearAllSchedules();
      console.log('Cleared all scheduled message timeouts');
      
      // Reset schedule data
      isScheduling = false;
      isScheduleStopped = true;
      scheduleStartTime = null;
      scheduleEndTime = null;
      console.log('Reset scheduling state');
    }
    
    // Reset sending results
    sendingResults = {
      success: [],
      failed: [],
      scheduled: [],
      current: null,
      total: 0,
      processed: 0
    };
    console.log('Reset sending results data');
    
    res.json({ success: true, message: 'All data deleted successfully' });
  } catch (error) {
    console.error('Error cleaning up data:', error);
    res.status(500).json({ error: 'Failed to clean up data: ' + error.message });
  }
});

// Route for logout and cleaning up data
app.get('/logout', (req, res) => {
  try {
    console.log('User requested logout - cleaning up session and data');
    
    // Save current status to restore response
    const wasConnected = !!whatsappClient;
    
    // Close whatsapp session if it exists
    if (whatsappClient) {
      try {
        whatsappClient.close();
        console.log('WhatsApp client session closed');
      } catch (error) {
        console.error('Error closing WhatsApp client:', error);
      }
      
      whatsappClient = null;
      qrCodeData = null;
    }
    
    // Cancel all scheduled messages
    if (isScheduling) {
      clearAllSchedules();
      console.log('Cleared all scheduled messages');
      
      isScheduling = false;
      isScheduleStopped = true;
      scheduleStartTime = null;
      scheduleEndTime = null;
    }
    
    // Reset sending results
    sendingResults = {
      success: [],
      failed: [],
      scheduled: [],
      current: null,
      total: 0,
      processed: 0
    };
    
    // Clean up files
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      try {
        const files = fs.readdirSync(uploadsDir);
        for (const file of files) {
          const filePath = path.join(uploadsDir, file);
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
            console.log(`Deleted file on logout: ${filePath}`);
          }
        }
      } catch (error) {
        console.error('Error cleaning up files on logout:', error);
      }
    }
    
    console.log('Logout complete - all data cleaned');
    
    // Send response
    res.json({
      success: true,
      message: wasConnected ? 'Logged out and all data cleared' : 'All data cleared',
      wasConnected: wasConnected
    });
    
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ error: 'Error during logout: ' + error.message });
  }
});

app.post('/schedule', (req, res) => {
  const { numbers, message, spreadHours, timer } = req.body;
  let messageData = [];

  try {
    // Create scheduled messages
    if (spreadHours) {
      // Create a schedule spread over 24 hours (in milliseconds)
      const scheduledItems = createRandomSchedule(numbers, 24 * 60 * 60 * 1000);
      
      // Current time as base
      const now = Date.now();
      
      // Create message objects with scheduled times
      messageData = scheduledItems.map(item => ({
        number: item.number,
        message: message,
        scheduledTime: new Date(now + item.delay).toISOString(),
        status: 'scheduled',
        id: uuidv4()
      }));
    } else {
      // Schedule all messages immediately or with specified timer
      const delayMs = timer ? timer * 1000 : 0;
      const scheduledTime = new Date(Date.now() + delayMs).toISOString();
      
      messageData = numbers.map(number => ({
        number,
        message,
        scheduledTime,
        status: 'scheduled',
        id: uuidv4()
      }));
    }

    // Add messages to the queue
    messageQueue.push(...messageData);
    
    // Start processing the queue if it's not already running
    if (!sendingInProgress) {
      processMessageQueue();
    }

    res.json({ success: true, messageData });
  } catch (error) {
    console.error('Error scheduling messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Process messages in the queue
async function processMessageQueue() {
  if (messageQueue.length === 0 || sendingInProgress) {
    return;
  }

  sendingInProgress = true;

  try {
    while (messageQueue.length > 0) {
      const item = messageQueue.shift();
      
      // Check if it's time to send the message
      const now = new Date();
      if (item.scheduledTime > now) {
        // Put it back in the queue and wait
        messageQueue.unshift(item);
        
        // Wait until the scheduled time
        const waitTime = Math.max(0, item.scheduledTime - now);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      try {
        // Update status
        item.status = 'processing';
        
        // Format number for WhatsApp
        let formattedNumber = item.number.trim().replace(/\D/g, '');
        if (!formattedNumber.endsWith('@c.us')) {
          formattedNumber = `${formattedNumber}@c.us`;
        }

        // Send the message
        await whatsappClient.sendText(formattedNumber, item.message);
        
        // Update status
        item.status = 'sent';
        item.processedTime = new Date();
        
        // Record success
        sendingResults.success.push({
          number: item.number,
          status: 'success',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error(`Error sending message to ${item.number}:`, error);
        
        // Update status
        item.status = 'failed';
        item.error = error.message;
        item.processedTime = new Date();
        
        // Record failure
        sendingResults.failed.push({
          number: item.number,
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
      
      // Update processed count
      sendingResults.processed++;
      
      // Add a small delay between messages to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    sendingInProgress = false;
    
    // Check if there are more messages added to the queue while processing
    if (messageQueue.length > 0) {
      processMessageQueue();
    }
  }
}

// Send a message to a single WhatsApp number
async function sendMessage(phoneNumber, message) {
  try {
    // Format number for WhatsApp
    let formattedNumber = phoneNumber.trim().replace(/\D/g, '');
    if (!formattedNumber.endsWith('@c.us')) {
      formattedNumber = `${formattedNumber}@c.us`;
    }
    
    console.log(`Sending message to ${phoneNumber} (formatted: ${formattedNumber})`);
    
    // Send the original message without modification
    await whatsappClient.sendText(formattedNumber, message);
    
    console.log(`Successfully sent message to ${phoneNumber}`);
    return { success: true };
  } catch (error) {
    console.error(`Error sending message to ${phoneNumber}:`, error);
    return { 
      success: false, 
      error: error.message || 'Failed to send message' 
    };
  }
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  
  // Clean up uploads directory on server start
  cleanUploadsDirectory();
}); 