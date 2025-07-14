# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a real-time collaborative BPMN diagram editor built with:
- **Client**: BPMN.js + Y.js CRDT + WebSocket
- **Server**: Express + WebSocket + MongoDB
- **Language**: Korean README, English/Korean code comments

## Common Development Commands

### Server Commands (in /server directory)
```bash
npm run dev          # Start development server with nodemon
npm start           # Start production server
npm test           # Run Jest tests
npm run lint       # Run ESLint
```

### Client Commands (in /client directory)
```bash
npm start           # Start webpack dev server (development mode)
npm run build      # Build for production
npm test           # Run Jest tests
npm run lint       # Run ESLint
```

### Project Setup
```bash
# Server setup
cd server && npm install
# Client setup
cd client && npm install
```

## Architecture Overview

### Client-Side Architecture (/client/src/)
- **core/**: Real-time synchronization between BPMN.js and Y.js CRDT
  - `BpmnSyncManager.js`: Bidirectional sync manager
  - `ConflictResolver.js`: Handles editing conflicts
  - `connection-manager.js`: WebSocket connection management
  - `PerformanceOptimizer.js`: Performance optimization

- **crdt/**: Y.js CRDT implementation
  - `YjsDocumentManager.js`: Y.js document lifecycle management
  - `YjsProviders.js`: WebSocket and persistence providers

- **ui/**: Collaboration UI components
  - `AwarenessUI.js`: Real-time user cursors and awareness
  - `CollaborationPanel.js`: Collaboration controls

### Server-Side Architecture (/server/src/)
- **websocket/**: WebSocket-based collaboration server
- **models/**: MongoDB models for sessions, documents, comments
- **services/**: Business logic for sessions, persistence, notifications
- **server.js**: Main server with Express + WebSocket integration

## Key Technical Details

### Y.js CRDT Integration
- Uses Y.Map for BPMN elements storage
- WebSocket provider for real-time sync
- Conflict-free collaborative editing
- State vector management for efficient synchronization

### BPMN.js Integration
- Event-driven sync with commandStack events
- Loop prevention using origin tracking
- Debounced updates (300ms) for performance

### MongoDB Collections
Key collections include:
- `collaboration_sessions`: Active collaboration sessions
- `yjs_documents`: Y.js document states and updates
- `collaboration_comments`: Element-specific comments

## Development Rules (from RULES.md)

### Mandatory Requirements
1. **Executable State**: All implementations must be runnable without errors
2. **Git Commits**: Must commit all changes with clear messages
3. **TODO Management**: Use TodoWrite tool for progress tracking
4. **Testing**: Run tests and builds before considering work complete

### Quality Standards
- Run `npm run lint` and `npm test` before commits
- Ensure MongoDB connection works (currently set to 210.1.1.40:27017)
- Follow existing code patterns and Korean documentation style

## Architecture Patterns

### Synchronization Flow
1. User action → BPMN.js event
2. BpmnSyncManager transforms to Y.js format
3. Y.js CRDT handles conflict resolution
4. WebSocket broadcasts to other clients
5. Remote clients apply changes via Y.js → BPMN.js sync

### Error Handling
- Graceful degradation for network issues
- Automatic reconnection with exponential backoff
- Conflict resolution with user notification
- Comprehensive logging throughout the stack

## Important Notes

- ConflictResolver is temporarily disabled due to infinite loop issues
- IndexedDB provider disabled to prevent memory leaks
- Server runs on port 3000, client on port 3001
- MongoDB URL configurable via environment variables
- All UI text and documentation in Korean