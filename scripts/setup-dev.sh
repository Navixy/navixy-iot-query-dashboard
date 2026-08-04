#!/bin/bash

# SQL Report Dashboard - Development Setup Script
# This script sets up the development environment and starts all services

set -e  # Exit on any error

# Machine-local port overrides — the same git-ignored .env that docker compose interpolates
# from and vite.config.ts reads. Inert without it: every use below falls back to the
# original port, so a fresh clone behaves exactly as before.
if [ -f "$(dirname "$0")/../.env" ]; then set -a; . "$(dirname "$0")/../.env"; set +a; fi

echo "🚀 SQL Report Dashboard - Development Setup"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "backend" ]; then
    print_error "Please run this script from the project root directory"
    exit 1
fi

print_status "Setting up development environment..."

# 1. Check and install dependencies
print_status "Checking dependencies..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

# Check if Docker is installed and running
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install Docker first."
    exit 1
fi

if ! docker info &> /dev/null; then
    print_error "Docker is not running. Please start Docker first."
    exit 1
fi

print_success "All required tools are available"

# 2. Setup environment variables
print_status "Setting up environment variables..."

# Create .env file in backend if it doesn't exist
if [ ! -f "backend/.env" ]; then
    print_status "Creating backend/.env file..."
    cat > backend/.env << EOF
# Environment Configuration
NODE_ENV=development
PORT=${BACKEND_PORT:-3001}

# Client Settings Database Username (REQUIRED)
# This username is used to connect to the client's database for storing
# user settings (users, user_roles, global_variables, reports, sections).
# The password is taken from the user's login URL (iotDbUrl).
CLIENT_SETTINGS_DB_USER=dashboard_settings

# Redis Cache
REDIS_URL=redis://localhost:${REDIS_HOST_PORT:-6379}

# JWT Configuration
JWT_SECRET=dev_jwt_secret_key_change_in_production
JWT_EXPIRES_IN=24h

# Security
RATE_LIMIT_WINDOW_MS=300000
RATE_LIMIT_MAX_REQUESTS=5000

# Analytics Service
ANALYTICS_SERVICE_URL=http://localhost:${ANALYTICS_HOST_PORT:-8001}

# Report Schema Repository
# REPORT_SCHEMA_URL= # Optional: URL for default report schema

# Logging
LOG_LEVEL=info
LOG_FILE=logs/app.log
EOF
    print_success "Created backend/.env file"
    print_warning "Please update CLIENT_SETTINGS_DB_USER with actual username"
else
    print_status "backend/.env file already exists"
fi

# 3. Setup Redis
print_status "Setting up Redis..."

# Stop any existing Redis container
docker stop redis-dev 2>/dev/null || true
docker rm redis-dev 2>/dev/null || true

# Start Redis container
docker run -d --name redis-dev -p "${REDIS_HOST_PORT:-6379}:6379" redis:7-alpine
print_success "Redis container started"

# Wait for Redis to be ready
sleep 2
if docker exec redis-dev redis-cli ping &> /dev/null; then
    print_success "Redis is ready"
else
    print_error "Redis failed to start"
    exit 1
fi

# 4. Install dependencies
print_status "Installing dependencies..."

# Install frontend dependencies
if [ ! -d "node_modules" ]; then
    print_status "Installing frontend dependencies..."
    npm install
    print_success "Frontend dependencies installed"
else
    print_status "Frontend dependencies already installed"
fi

# Install backend dependencies
if [ ! -d "backend/node_modules" ]; then
    print_status "Installing backend dependencies..."
    cd backend && npm install && cd ..
    print_success "Backend dependencies installed"
else
    print_status "Backend dependencies already installed"
fi

# 5. Start services
print_status "Starting services..."

# Kill any existing processes
pkill -f "tsx watch" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true

# Start backend
print_status "Starting backend server..."
cd backend
npm run dev &
BACKEND_PID=$!
cd ..

# Wait for backend to start
sleep 5

# Check if backend is running
if curl -s "http://localhost:${BACKEND_PORT:-3001}/health" > /dev/null; then
    print_success "Backend server started successfully"
else
    print_warning "Backend server may still be starting... (database connection happens on first request)"
fi

# Start frontend
print_status "Starting frontend server..."
npm run dev &
FRONTEND_PID=$!

# Wait for frontend to start
sleep 3

# Check if frontend is running. The old second arm probed :8081 as Vite's fall-forward
# port; vite.config.ts now sets strictPort, so that fallback cannot happen — and on a
# machine running other projects, :8081 answering means some OTHER dev server is up.
if curl -s "http://localhost:${DEV_PORT:-8080}" > /dev/null; then
    print_success "Frontend server started successfully"
else
    print_warning "Frontend server may still be starting..."
fi

# 6. Display status
echo ""
echo "🎉 Setup Complete!"
echo "=================="
echo ""
print_success "Backend: http://localhost:${BACKEND_PORT:-3001}"
print_success "Frontend: http://localhost:${DEV_PORT:-8080}"
print_success "Health Check: http://localhost:${BACKEND_PORT:-3001}/health"
echo ""
print_status "Services running:"
print_status "  - Redis: localhost:${REDIS_HOST_PORT:-6379} (Docker container)"
print_status "  - Backend: PID $BACKEND_PID"
print_status "  - Frontend: PID $FRONTEND_PID"
echo ""
print_warning "Note: Database connection happens on first login request."
print_warning "Make sure CLIENT_SETTINGS_DB_USER is configured in backend/.env"
echo ""
print_status "To stop all services, run: ./scripts/stop-dev.sh"
echo ""

# Save PIDs for cleanup script
mkdir -p scripts
echo "$BACKEND_PID" > scripts/backend.pid
echo "$FRONTEND_PID" > scripts/frontend.pid

print_success "Development environment is ready! 🚀"
