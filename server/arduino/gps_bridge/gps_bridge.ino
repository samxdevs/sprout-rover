/*
 * Sprout GPS bridge — Arduino Uno
 * ================================
 * Reads the GPS module and streams one fix per second to the Raspberry Pi
 * over USB serial, in the CSV format server/gps/serial_gps.py parses:
 *
 *   GPS,<lat>,<lon>,<speed_kmh>,<course_deg>,<sats>,<hdop>
 *   GPS,NOFIX,<sats>
 *
 * Wiring (NEO-6M / NEO-7M / NEO-8M or similar UART GPS):
 *   GPS VCC -> 5V   (most breakout boards have an onboard 3.3V regulator;
 *                    bare 3.3V-only modules go to 3.3V instead)
 *   GPS GND -> GND
 *   GPS TX  -> D4   (module transmits into the Uno)
 *   GPS RX  -> D3   (optional — only needed to configure the module;
 *                    use a 1k/2k voltage divider, the module's RX is 3.3V)
 *
 * Library: TinyGPSPlus (Arduino IDE > Tools > Manage Libraries > "TinyGPSPlus"
 * by Mikal Hart). GPS modules default to 9600 baud NMEA.
 *
 * The Pi side auto-reconnects, so plugging the Uno in at any time is fine.
 * First fix outdoors takes 30 s - 5 min from cold; indoors it may never fix.
 */

#include <SoftwareSerial.h>
#include <TinyGPSPlus.h>

static const int GPS_RX_PIN = 4;   // Uno pin the GPS TX line arrives on
static const int GPS_TX_PIN = 3;   // Uno pin to the GPS RX line (via divider)
static const long GPS_BAUD = 9600;
static const long PI_BAUD = 115200;
static const unsigned long REPORT_MS = 1000;

TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);
unsigned long lastReport = 0;

void setup() {
  Serial.begin(PI_BAUD);      // USB to the Raspberry Pi
  gpsSerial.begin(GPS_BAUD);  // GPS module
}

void loop() {
  // Feed every incoming NMEA byte to the parser.
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  unsigned long now = millis();
  if (now - lastReport < REPORT_MS) return;
  lastReport = now;

  if (gps.location.isValid() && gps.location.age() < 5000) {
    Serial.print(F("GPS,"));
    Serial.print(gps.location.lat(), 6);
    Serial.print(F(","));
    Serial.print(gps.location.lng(), 6);
    Serial.print(F(","));
    Serial.print(gps.speed.isValid() ? gps.speed.kmph() : 0.0, 1);
    Serial.print(F(","));
    if (gps.course.isValid()) Serial.print(gps.course.deg(), 0);
    Serial.print(F(","));
    Serial.print(gps.satellites.isValid() ? gps.satellites.value() : 0);
    Serial.print(F(","));
    if (gps.hdop.isValid()) Serial.print(gps.hdop.hdop(), 1);
    Serial.println();
  } else {
    Serial.print(F("GPS,NOFIX,"));
    Serial.println(gps.satellites.isValid() ? gps.satellites.value() : 0);
  }
}
