Welcome to RS232-U
	The easy way to test RS232 communication.
	
1. Charging and Power
2. Buttons & Navigation
3. Options and Functions
4. connectors and terminals
5. Firmware Updates

-------------------------------------------------------------------------------------------

1. Charging and Power -

1.0 The RS232-U uses a rechargable 4.2v 2000mAh Lithium Polymer (LiPo) battery.
	For the best experience, use the USB-C cable that comes with your device.
	
	- Do NOT Puncture, Crush, or Damnage battery as this is a fire hazzard
	- Keep In a Dry, Cool/ Room temprature area when charging 
	- For the Best Lifespan of the battery, keep the charge between 30 - 80 %
	- If the device gets hot, discontinue use immediately 

1.1 The RS232-U can run on battery power or via USB-C bus power. 
	If you want to save battery, plug the RS232-U in without turning the power switch to "On"

1.2 If you want to charge the battery

	- Turn on the RS232-U (The power switch links the battery to the main circuit)
		The RS232-U will not charge if its not powered on!!
	- Connect to USB-C to a power source (5v 2A recommended)

1.3 You can use the RS232-U while its charging.

-------------------------------------------------------------------------------------------

2. Buttons & Navigation
	
2.0 The RS232-U has a Rocker style power switch located on the front left-hand side of the device.

	- Up = Battery Connected
	- Down = Battery Disconnected

2.1 Note: The Battery will not charge if the power switch is in the down position
	even if connected to a USC-C power source.

2.2 Located on the front right-hand side of the device are the navigation Buttons for navigation.

	- Up
	- Down
	- Select (right)
	- Back (Left)
	
2.3 Menus can be navigated by moving up or down, Using Select (right) will navigate
	into a new menu, or can be used to trigger a function.

2.4 You can move back a page or cancel a function by using back (left)

2.5 Some menus / functions only have one function. Simply clicking select (left)
	will trigger the function.

-------------------------------------------------------------------------------------------

3. Options and Functions

3.0 Main Menu Options 

	- Display Test
	- Loopback test
	- Coms Check
	- Device Settings
	

3.1 Display Test Feature-

3.2 Display Test will send brand specific Power 'On' and 'Off' RS232 commands.

	- Brand names followed by (beta) have not yet been tested
		but contain manufacture specific protocols.
		
	- New Brands and (beta) commands will be added in later firmware versions.
	
	- If a (beta) display is tested in field, please send a notification confirming
		the (beta)'s validity and it will be updated in later firmware releases.
		

3.2 Loopback Test Feature -

	- The loop back test sends a HEX command out of Tx,
		while Rx is waiting to receive that expected byte.
		If the Rx doesn't receive this byte, the test will read "failed".

	- In order to execute the test properly,
		Tx and Rx pins must be shorted (connected together).
		By connecting Tx and Rx at the very end of your signal chain,
		you can confirm that the signal is able to reach the intended device.

	- A successful test will read "successful"


3.3 Coms Check - 

3.4 Communications (Coms) Check will sent a general byte to 'Probe' for an Rx Response
	from a connected device.

	- There are 4 different options '?', 'GET', "Carriage Return (\r)", and '0x00'.
	- Not every device will respond to a generic probe.
	- This feature can also be used as a loopback test.
	- If the Probe is successful the device will display the returned value
	- if the Probe failed, the device will state no RX response.
	

3.5 Device Settings -

3.6 Currently the only setting availble is Screen Brightness.

	- You must select the brightness level desired. Brightness will not change on scroll.
	- the RS232-U will remember the brightness set even after power off.
	
-------------------------------------------------------------------------------------------

	
4. connectors and terminals

4.1 The RS232-U comes with:

	- 1 Male DB9
	- 1 Female DB9
	- 1 Three pin Block Connector	
	
	- All Tx are connected to the same line
	- All Rx are connected to the same line
	- All grounds are connected to the same line
	
4.2 USB-C

	- Currently the USB-C is for charging
	- Firmware Updates can be done by connecting via USB-C and using the RS232UPDATER

-------------------------------------------------------------------------------------------

5. Firmware Updates

4.1 How to update the firmware 

	- Firmware Updates are possible with the RS232UPDATER
	- Connect the RS232-U to your computer via USB-C
	- Open the RS232UPDATER Web Serial Updater Tool
	- The RS232UPDATER MUST be opened with Google Chrome or Microsoft Edge due to protocol standards
	- Select the Firmware .bin file. "rs232u_(versionNumber).bin"
	- Connect to the RS232-U's COM port (com port number may change)
	- The COM device is titled "tinyUSB Serial (COM#)"
	
	Note: if you receive a "transiet" error, refresh the page and try again

	- Once the RS232-U is connected and ready, the "Start Flashing" button will highlight green
	- Click "Start Flashing" to push the update.
	- DO NOT DISCONNECT THE RS232-U WHILE THE FIRMWARE IS UPDATING
	- After the firmware update is completed the RS232-U will reboot
	- After reboot the RS232-U is safe to disconnect

4.2 Download the RS232UPDATER

	- The RS232UPDATER can be found at the link below
	- https://github.com/Lo-Z/RS232-U/tree/main/Firmware
	
