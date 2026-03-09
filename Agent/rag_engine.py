from langchain_community.vectorstores import Chroma
from langchain_openai import OpenAIEmbeddings
from openai import OpenAI

class RAGAgent:
    def __init__(self):
        """
        Initialize the RAG Agent by loading the pre-indexed 
        vector database containing patient medical records.
        """
        # Load the persisted Vector DB from the local './db' directory
        # This DB should contain vectorized versions of patient history/medical manuals
        self.vector_db = Chroma(
            persist_directory="./db", 
            embedding_function=OpenAIEmbeddings()
        )

    def get_intelligent_advice(self, patient_id, emergency_type, sensor_data):
        """
        Combines real-time sensor data with retrieved patient history 
        to generate context-aware medical instructions via an LLM.
        """
        
        # 1. RETRIEVAL STEP: 
        # Search for the most relevant medical context for the specific patient ID
        query = f"Medical history and conditions for patient {patient_id}"
        docs = self.vector_db.similarity_search(query, k=1)
        
        # Extract content if a match is found, otherwise use a default string
        patient_context = docs[0].page_content if docs else "No specific history found for this patient."

        # 2. PROMPT ENGINEERING STEP:
        # Construct a high-context prompt for the LLM
        prompt = f"""
        EMERGENCY TYPE: {emergency_type}
        REAL-TIME SENSOR DATA: {sensor_data}
        PATIENT MEDICAL HISTORY: {patient_context}
        
        TASK: As an expert medical assistant, analyze the emergency and the patient's 
        history. Provide one clear, actionable instruction for the caregiver 
        to follow immediately.
        """
        
        # 3. GENERATION STEP:
        # Send the combined data to the LLM (GPT-4) to get a smart response
        try:
            response = client.chat.completions.create(
                model="gpt-4",
                messages=[
                    {"role": "system", "content": "You are a professional medical monitoring assistant."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5 # Keeps the output focused and professional
            )
            
            # Return the generated text advice
            return response.choices[0].message.content
        
        except Exception as e:
            return f"Error generating advice: {str(e)}"